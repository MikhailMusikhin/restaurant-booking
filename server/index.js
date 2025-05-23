const fs        = require('fs');
const path      = require('path');
const express   = require('express');
const session   = require('express-session');
const cors      = require('cors');
const pool      = require('./db');                       
const PgSession = require('connect-pg-simple')(session); 
const cron      = require('node-cron');

const bookRoute  = require('./routes/book');
const tableRoute = require('./routes/tables');
const authRoute  = require('./routes/auth');
const ensureAuth = require('./middleware/ensureAuth');
const adminRoute = require('./routes/admin');

const app = express();

async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema migrations applied');
}

function setupSessions() {
  app.use(
    session({
      store: new PgSession({
        pool,               
        tableName: 'sessions'
      }),
      secret: process.env.SESSION_SECRET || 'default-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * 60 * 60 * 2 } 
    })
  );
}

function setupParsers() {
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
}

function setupStatic() {
  app.use('/css', express.static(path.join(__dirname, '..', 'css')));
  app.use('/js',  express.static(path.join(__dirname, '..', 'js')));
  app.use('/img', express.static(path.join(__dirname, '..', 'img')));
}

function setupViews() {
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
}

function setupRoutes() {
  app.get('/',        (req, res) => res.render('pages/index',   { user: req.session.user }));
  app.get('/booking', (req, res) => res.render('pages/booking', { user: req.session.user }));

  app.use('/', authRoute);

  app.get('/account', ensureAuth, async (req, res, next) => {
    try {
      const user = req.session.user;
      const { rows } = await pool.query(
        `SELECT b.id, b.booking_date, b.booking_time, b.table_id, t.seats
           FROM bookings b
           JOIN tables t ON t.id = b.table_id
          WHERE b.user_id = $1
          ORDER BY b.booking_date DESC, b.booking_time`,
        [user.id]
      );
      const bookings = rows.map(b => ({
        ...b,
        dateFormatted: b.booking_date.toLocaleDateString('ru-RU')
      }));
      res.render('pages/account', { user, bookings });
    } catch (err) {
      next(err);
    }
  });
  app.post('/account/cancel', ensureAuth, async (req, res, next) => {
    try {
      await pool.query(
        'DELETE FROM bookings WHERE id = $1 AND user_id = $2',
        [req.body.id, req.session.user.id]
      );
      res.redirect('/account');
    } catch (err) {
      next(err);
    }
  });
  app.post('/account/delete', ensureAuth, async (req, res, next) => {
    const userId = req.session.user.id;
    try {
      await pool.query('DELETE FROM bookings WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users    WHERE id      = $1', [userId]);
      req.session.destroy(err => {
        if (err) return next(err);
        res.redirect('/login');
      });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/book', require('./routes/book'));
  app.use('/api/tables', tableRoute);
  app.use('/',            adminRoute);
  app.use('/', require('./routes/admin'));

}

function setupCron() {
  cron.schedule(
    '0 * * * *', 
    async () => {
      try {
        await pool.query(`
          DELETE FROM bookings
          WHERE booking_date < CURRENT_DATE
             OR (booking_date = CURRENT_DATE
                 AND (split_part(booking_time, ' - ', 2))::time < LOCALTIME)
        `);
        console.log('Expired bookings cleaned up');
      } catch (err) {
        console.error('Error cleaning expired bookings:', err);
      }
    },
    { timezone: 'Europe/Amsterdam' }
  );
}

function setupNotFound() {
  app.use((req, res) => res.status(404).send('Not Found'));
}

(async () => {
  try {
    await runMigrations();
    setupSessions();
    setupParsers();
    setupStatic();
    setupViews();
    setupRoutes();
    setupCron();
    setupNotFound();

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  } catch (err) {
    console.error('Fatal error on startup:', err);
    process.exit(1);
  }
})();
