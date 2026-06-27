// server.js — Seeds FinCap Visitor Management System
// Email via Resend HTTP API (works on Render free tier — no SMTP ports needed)
const express = require('express');
const sql = require('mssql');
const { Resend } = require('resend');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: process.env.CORS_CREDENTIALS === 'true' || false
}));
app.use(bodyParser.json({ limit: process.env.MAX_FILE_SIZE_MB || '50mb' }));
app.use(bodyParser.urlencoded({
  limit: process.env.MAX_FIELD_SIZE_MB || '50mb',
  extended: true
}));
app.use(express.static('public'));

// ── Environment validation ──────────────────────────────────────────────────
const requiredEnvVars = [
  'DB_USER', 'DB_PASSWORD', 'DB_SERVER', 'DB_NAME', 'DB_PORT',
  'JWT_SECRET', 'RESEND_API_KEY'
];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0 && process.env.NODE_ENV !== 'test') {
  console.error('❌ Missing required environment variables:', missingVars);
  process.exit(1);
}

// ── Resend HTTP email client (works on Render free tier) ───────────────────
const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_FROM = process.env.EMAIL_FROM ||
  `${process.env.EMAIL_FROM_NAME || 'Seeds FinCap Visitor System'} <${process.env.EMAIL_FROM_ADDRESS || 'onboarding@resend.dev'}>`;

// ── SQL Server config ───────────────────────────────────────────────────────
const SQL_CONFIG = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT),
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    connectTimeout: parseInt(process.env.DB_CONNECT_TIMEOUT) || 30000,
    requestTimeout: parseInt(process.env.DB_REQUEST_TIMEOUT) || 30000
  },
  pool: {
    max: parseInt(process.env.DB_POOL_MAX) || 10,
    min: parseInt(process.env.DB_POOL_MIN) || 0,
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,
    acquireTimeoutMillis: parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT) || 30000
  },
  connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 15000
};

const JWT_SECRET = process.env.JWT_SECRET;

// ── Branding ────────────────────────────────────────────────────────────────
const SEEDS_BRANDING = {
  logoUrl: 'https://cdn.prod.website-files.com/65b65b84c3edfa5897cdfb0b/65d10f4087845b6e392e1dcd_seeds.png',
  companyName: 'Seeds Fincap Pvt. Ltd.',
  primaryColor: '#2E5BFF',
  secondaryColor: '#00D4AA',
  textColor: '#2E384D',
  lightBg: '#F8F9FC',
  borderColor: '#E0E6FF'
};

let sqlPool;

// ── DB connect with retry ───────────────────────────────────────────────────
async function connectWithRetry(maxRetries = 5, initialDelay = 5000) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔌 DB connection attempt ${attempt}/${maxRetries}...`);
      sqlPool = await sql.connect(SQL_CONFIG);
      await sqlPool.request().query('SELECT @@VERSION AS version');
      console.log('✅ SQL Server Connected');
      return sqlPool;
    } catch (err) {
      console.error(`❌ Attempt ${attempt} failed:`, err.message);
      if (attempt === maxRetries) throw new Error(`DB failed after ${maxRetries} attempts: ${err.message}`);
      console.log(`⏳ Waiting ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 30000);
    }
  }
}

async function initSqlConnection() {
  await connectWithRetry();
  console.log('✅ Email: Resend HTTP API (no SMTP ports needed)');
  await createTables();
}

// ── Create tables ───────────────────────────────────────────────────────────
async function getAdminHash() {
  return bcrypt.hash(process.env.ADMIN_DEFAULT_PASSWORD || 'admin123', 10);
}

async function createTables() {
  try {
    await sqlPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='vs_users' AND xtype='U')
      BEGIN
        CREATE TABLE vs_users (
          id INT IDENTITY(1,1) PRIMARY KEY,
          username NVARCHAR(50) UNIQUE NOT NULL,
          email NVARCHAR(100) UNIQUE NOT NULL,
          password NVARCHAR(255) NOT NULL,
          role NVARCHAR(20) DEFAULT 'reception',
          is_active BIT DEFAULT 1,
          last_login DATETIME2 NULL,
          created_at DATETIME2 DEFAULT GETDATE()
        );
        CREATE INDEX idx_users_username ON vs_users(username);
        CREATE INDEX idx_users_email ON vs_users(email);
      END
      ELSE
      BEGIN
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('vs_users') AND name='is_active')
          ALTER TABLE vs_users ADD is_active BIT DEFAULT 1;
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('vs_users') AND name='last_login')
          ALTER TABLE vs_users ADD last_login DATETIME2 NULL;
      END
    `);

    await sqlPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='vs_visitors' AND xtype='U')
      BEGIN
        CREATE TABLE vs_visitors (
          id INT IDENTITY(1,1) PRIMARY KEY,
          visitor_name NVARCHAR(100) NOT NULL,
          mobile NVARCHAR(15),
          host_employee NVARCHAR(100),
          host_email NVARCHAR(100) NOT NULL,
          purpose NVARCHAR(MAX),
          photo_base64 NVARCHAR(MAX),
          qr_code_data NVARCHAR(MAX),
          checkin_time DATETIME2 DEFAULT GETDATE(),
          checkout_time DATETIME2 NULL,
          status NVARCHAR(20) DEFAULT 'checked_in',
          created_by NVARCHAR(50),
          created_at DATETIME2 DEFAULT GETDATE()
        );
        CREATE INDEX idx_visitors_checkin ON vs_visitors(checkin_time);
        CREATE INDEX idx_visitors_status ON vs_visitors(status);
        CREATE INDEX idx_visitors_host_email ON vs_visitors(host_email);
        CREATE INDEX idx_visitors_created_at ON vs_visitors(created_at);
      END
      ELSE
      BEGIN
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('vs_visitors') AND name='qr_code_data')
          ALTER TABLE vs_visitors ADD qr_code_data NVARCHAR(MAX);
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('vs_visitors') AND name='photo_base64')
          ALTER TABLE vs_visitors ADD photo_base64 NVARCHAR(MAX);
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('vs_visitors') AND name='created_by')
          ALTER TABLE vs_visitors ADD created_by NVARCHAR(50);
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('vs_visitors') AND name='created_at')
          ALTER TABLE vs_visitors ADD created_at DATETIME2 DEFAULT GETDATE();
      END
    `);

    const adminHash = await getAdminHash();
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@seedsfincap.com';
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const req = sqlPool.request();
    req.input('adminEmail', sql.NVarChar, adminEmail);
    req.input('adminUsername', sql.NVarChar, adminUsername);
    req.input('adminHash', sql.NVarChar, adminHash);
    await req.query(`
      IF NOT EXISTS (SELECT 1 FROM vs_users WHERE username=@adminUsername OR email=@adminEmail)
        INSERT INTO vs_users (username, email, password, role, is_active)
        VALUES (@adminUsername, @adminEmail, @adminHash, 'admin', 1);
      ELSE
        UPDATE vs_users SET password=@adminHash, role='admin', is_active=1
        WHERE username=@adminUsername OR email=@adminEmail;
    `);

    console.log('✅ Tables ready: vs_users, vs_visitors');
  } catch (err) {
    console.error('❌ Table creation error:', err.message);
    if (!err.message.includes('Invalid column name')) throw err;
  }
}

// ── QR Code ─────────────────────────────────────────────────────────────────
async function generateQRCode(qrData) {
  const dataURL = await QRCode.toDataURL(JSON.stringify(qrData), {
    width: 400, margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' }
  });
  const buffer = await QRCode.toBuffer(JSON.stringify(qrData), {
    width: 400, margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' }
  });
  return { dataURL, buffer, base64: dataURL.split(',')[1] };
}

// ── IST time helpers ─────────────────────────────────────────────────────────
const IST_TIMEZONE = 'Asia/Kolkata';

function pad(n) { return String(n).padStart(2, '0'); }

function parseSqlDateTimeAsIST(dateTime) {
  if (!dateTime) return new Date();
  if (dateTime instanceof Date) {
    if (isNaN(dateTime.getTime())) return new Date();
    const iso = `${dateTime.getUTCFullYear()}-${pad(dateTime.getUTCMonth()+1)}-${pad(dateTime.getUTCDate())}T${pad(dateTime.getUTCHours())}:${pad(dateTime.getUTCMinutes())}:${pad(dateTime.getUTCSeconds())}+05:30`;
    return new Date(iso);
  }
  if (typeof dateTime === 'string') {
    const t = dateTime.trim();
    if (!t) return new Date();
    const n = t.includes('T') ? t : t.replace(' ', 'T');
    return new Date(/(Z|[+-]\d{2}:\d{2})$/i.test(n) ? n : `${n}+05:30`);
  }
  return new Date(dateTime);
}

function formatDateTimeIST(dateTime, { fromDatabase = false } = {}) {
  const date = fromDatabase ? parseSqlDateTimeAsIST(dateTime) : new Date(dateTime);
  if (isNaN(date.getTime())) return formatDateTimeIST(new Date());
  const dateStr = date.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone: IST_TIMEZONE });
  const timeStr = date.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true, timeZone: IST_TIMEZONE });
  return {
    fullDateTime: `${dateStr} at ${timeStr} IST`,
    dateOnly: dateStr,
    timeOnly: timeStr,
    dateTime: `${dateStr} ${timeStr}`,
    timestamp: date.toLocaleString('en-IN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true, timeZone: IST_TIMEZONE })
  };
}

function getCurrentISTTime() { return formatDateTimeIST(new Date()); }

function calculateVisitDuration(checkinTime, checkoutTime) {
  const checkin = parseSqlDateTimeAsIST(checkinTime);
  const checkout = checkoutTime instanceof Date ? checkoutTime : parseSqlDateTimeAsIST(checkoutTime);
  const ms = checkout - checkin;
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

// ── Email HTML Templates ─────────────────────────────────────────────────────
// Images are sent as CID attachments — email clients render these reliably.
// base64 data URIs are blocked by Gmail, Outlook, and most corporate mail servers.
function generateVisitorEmailHTML(visitorData, hasPhoto) {
  const checkin = visitorData.checkin_time
    ? formatDateTimeIST(visitorData.checkin_time, { fromDatabase: true })
    : getCurrentISTTime();
  const now = getCurrentISTTime();
  const p = SEEDS_BRANDING;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>New Visitor - Seeds FinCap</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f5f7fa;color:${p.textColor}}
.wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.08)}
.hdr{background:linear-gradient(135deg,${p.primaryColor},#1E40AF);padding:30px;text-align:center}
.hdr img{max-width:160px;height:auto;margin-bottom:16px;display:block;margin-left:auto;margin-right:auto}
.hdr h1{color:#fff;font-size:26px;font-weight:600;margin-bottom:8px}
.hdr p{color:rgba(255,255,255,.85);font-size:15px}
.body{padding:36px}
.badge{background:${p.secondaryColor};color:#fff;padding:8px 22px;border-radius:22px;display:inline-block;font-size:13px;font-weight:700;margin-bottom:24px;letter-spacing:.5px}
.tbl-wrap{border:1px solid ${p.borderColor};border-radius:12px;overflow:hidden;margin-bottom:28px}
.tbl-title{background:${p.primaryColor};color:#fff;padding:14px 20px;font-size:15px;font-weight:600}
table{width:100%;border-collapse:collapse}
.lbl{width:38%;padding:14px 18px;background:${p.lightBg};font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid ${p.borderColor};vertical-align:middle}
.val{padding:14px 18px;font-size:14px;color:#4A5568;font-weight:500;border-bottom:1px solid ${p.borderColor};vertical-align:middle}
tr:last-child .lbl,tr:last-child .val{border-bottom:none}
.hl{color:${p.primaryColor};font-weight:700;font-size:15px}
.status-in{background:linear-gradient(135deg,#48BB78,#38A169);color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700}
.qr-sec{text-align:center;padding:28px;border:2px solid ${p.secondaryColor};border-radius:12px;margin-bottom:28px;background:#fff}
.qr-sec h3{font-size:17px;font-weight:600;margin-bottom:8px;color:${p.textColor}}
.qr-sec p{color:#64748B;font-size:14px;margin-bottom:20px}
.qr-img{width:200px;height:200px;border:3px solid ${p.secondaryColor};border-radius:10px;padding:10px;background:#fff}
.photo-sec{text-align:center;padding:24px;border:2px solid ${p.primaryColor};border-radius:12px;margin-bottom:28px}
.photo-sec h3{font-size:17px;font-weight:600;margin-bottom:8px}
.photo-img{width:200px;height:200px;object-fit:cover;border-radius:10px;border:3px solid ${p.primaryColor}}
.steps{background:#F0F4FF;border-radius:12px;padding:22px;margin-bottom:24px}
.steps h3{font-size:16px;font-weight:600;margin-bottom:14px;color:${p.textColor}}
.steps table{border-collapse:collapse}
.steps td{padding:10px 14px;border:1px solid ${p.borderColor};font-size:13px}
.steps td:first-child{font-weight:700;width:40px;background:#fff}
.tz{background:#F0F9FF;padding:14px;border-radius:8px;border-left:4px solid #4299E1;font-size:12px;color:#2D3748;margin-top:4px}
.ftr{text-align:center;padding:22px;background:${p.lightBg};border-top:1px solid ${p.borderColor}}
.ftr img{max-width:100px;margin-bottom:12px;opacity:.75;display:block;margin-left:auto;margin-right:auto}
.ftr p{color:#94A3B8;font-size:11px;line-height:1.7}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <img src="${p.logoUrl}" alt="Seeds FinCap">
    <h1>Visitor Management System</h1>
    <p>Secure Digital Visitor Pass</p>
  </div>
  <div class="body">
    <div class="badge">🛡️ NEW VISITOR ALERT</div>

    <div class="tbl-wrap">
      <div class="tbl-title">📋 Visitor Information</div>
      <table>
        <tr><td class="lbl">Visitor Name</td><td class="val hl">${visitorData.visitor_name}</td></tr>
        <tr><td class="lbl">Mobile</td><td class="val">${visitorData.mobile || 'Not provided'}</td></tr>
        <tr><td class="lbl">Host Employee</td><td class="val">${visitorData.host_employee || 'N/A'}</td></tr>
        <tr><td class="lbl">Host Email</td><td class="val" style="font-family:monospace;font-size:13px">${visitorData.host_email}</td></tr>
        <tr><td class="lbl">Check-in Time</td><td class="val">${checkin.fullDateTime}<br><small style="color:#94A3B8">(IST GMT+5:30)</small></td></tr>
        <tr><td class="lbl">Purpose</td><td class="val" style="font-style:italic">${visitorData.purpose}</td></tr>
        <tr><td class="lbl">Visitor ID</td><td class="val"><span style="background:${p.secondaryColor};color:#fff;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">${visitorData.qr_id || visitorData.visitor_id || 'N/A'}</span></td></tr>
        <tr><td class="lbl">Status</td><td class="val"><span class="status-in">✅ Checked In</span></td></tr>
      </table>
    </div>

    <div class="qr-sec">
      <h3>📱 Digital Visitor Pass (QR Code)</h3>
      <p>Scan to verify visitor at security checkpoints</p>
      <img src="cid:visitor-qr-code" class="qr-img" alt="QR Code">
      <div style="margin-top:14px;font-size:13px;color:#64748B">
        ID: <strong>${visitorData.qr_id || 'N/A'}</strong> &nbsp;|&nbsp; Time: <strong>${checkin.timeOnly}</strong>
      </div>
    </div>

    ${hasPhoto ? `
    <div class="photo-sec">
      <h3>📸 Visitor Photo</h3>
      <img src="cid:visitor-photo" class="photo-img" alt="Visitor Photo">
    </div>` : ''}

    <div class="steps">
      <h3>🔐 Security Instructions</h3>
      <table>
        <tr><td>1.</td><td>Meet visitor at reception within 15 minutes</td></tr>
        <tr><td>2.</td><td>Keep this QR code accessible for security verification</td></tr>
        <tr><td>3.</td><td>Accompany visitor at all times within premises</td></tr>
        <tr><td>4.</td><td>Ensure visitor checks out before leaving the building</td></tr>
      </table>
    </div>

    <div class="tz">
      <strong>⏰ Timezone:</strong> All times in Indian Standard Time (IST – GMT+5:30).
      Email sent: ${now.timestamp}
    </div>
  </div>
  <div class="ftr">
    <img src="${p.logoUrl}" alt="Seeds FinCap">
    <p>Automated notification from Seeds FinCap Visitor Management System<br>
    IT Support: itsupport@seedsfincap.com<br>
    © ${new Date().getFullYear()} Seeds Fincap Pvt. Ltd. All rights reserved.</p>
  </div>
</div>
</body>
</html>`;
}

function generateCheckoutEmailHTML(visitorData, checkoutTime) {
  const checkout = formatDateTimeIST(checkoutTime);
  const checkin = formatDateTimeIST(visitorData.checkin_time, { fromDatabase: true });
  const now = getCurrentISTTime();
  const duration = calculateVisitDuration(visitorData.checkin_time, checkoutTime);
  const p = SEEDS_BRANDING;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Visitor Checked Out - Seeds FinCap</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f5f7fa;color:${p.textColor}}
.wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.08)}
.hdr{background:linear-gradient(135deg,#10B981,#059669);padding:30px;text-align:center}
.hdr img{max-width:160px;height:auto;margin-bottom:16px;display:block;margin-left:auto;margin-right:auto}
.hdr h1{color:#fff;font-size:26px;font-weight:600;margin-bottom:8px}
.hdr p{color:rgba(255,255,255,.85);font-size:15px}
.body{padding:36px}
.badge{background:#10B981;color:#fff;padding:8px 22px;border-radius:22px;display:inline-block;font-size:13px;font-weight:700;margin-bottom:24px}
.tbl-wrap{border:1px solid #E0E6FF;border-radius:12px;overflow:hidden;margin-bottom:28px}
.tbl-title{background:linear-gradient(135deg,#10B981,#059669);color:#fff;padding:14px 20px;font-size:15px;font-weight:600}
table{width:100%;border-collapse:collapse}
.lbl{width:38%;padding:14px 18px;background:${p.lightBg};font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #E0E6FF;vertical-align:middle}
.val{padding:14px 18px;font-size:14px;color:#4A5568;font-weight:500;border-bottom:1px solid #E0E6FF;vertical-align:middle}
tr:last-child .lbl,tr:last-child .val{border-bottom:none}
.dur{background:linear-gradient(135deg,#10B981,#059669);color:#fff;padding:6px 18px;border-radius:20px;font-weight:700;font-size:14px;display:inline-block}
.completed{background:linear-gradient(135deg,#48BB78,#38A169);color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700}
.sec-tbl{border:1px solid #BEE3F8;border-radius:12px;overflow:hidden;margin-bottom:24px}
.sec-hdr{background:#4299E1;color:#fff;padding:14px 20px;font-size:15px;font-weight:600}
.sec-tbl .lbl{background:#F0F9FF}
.sec-tbl .val{color:#059669;font-weight:700}
.tz{background:#F0F9FF;padding:14px;border-radius:8px;border-left:4px solid #4299E1;font-size:12px;color:#2D3748}
.ftr{text-align:center;padding:22px;background:${p.lightBg};border-top:1px solid ${p.borderColor}}
.ftr img{max-width:100px;margin-bottom:12px;opacity:.75;display:block;margin-left:auto;margin-right:auto}
.ftr p{color:#94A3B8;font-size:11px;line-height:1.7}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <img src="${p.logoUrl}" alt="Seeds FinCap">
    <h1>Visitor Check-out Complete</h1>
    <p>Security Notification</p>
  </div>
  <div class="body">
    <div class="badge">✅ VISITOR CHECKED OUT SUCCESSFULLY</div>

    <div class="tbl-wrap">
      <div class="tbl-title">📊 Visit Summary</div>
      <table>
        <tr><td class="lbl">Visitor Name</td><td class="val" style="color:#10B981;font-weight:700;font-size:15px">${visitorData.visitor_name}</td></tr>
        <tr><td class="lbl">Visit Duration</td><td class="val"><span class="dur">${duration}</span></td></tr>
        <tr><td class="lbl">Check-in Time</td><td class="val">⬇️ ${checkin.fullDateTime}</td></tr>
        <tr><td class="lbl">Check-out Time</td><td class="val">⬆️ ${checkout.fullDateTime}</td></tr>
        <tr><td class="lbl">Host Employee</td><td class="val">${visitorData.host_employee || 'N/A'}</td></tr>
        <tr><td class="lbl">Status</td><td class="val"><span class="completed">✅ Completed</span></td></tr>
      </table>
    </div>

    <div class="sec-tbl">
      <div class="sec-hdr">🔒 Security Status</div>
      <table>
        <tr><td class="lbl">Building Access</td><td class="val">✅ Revoked</td></tr>
        <tr><td class="lbl">Visitor Card</td><td class="val">✅ Returned</td></tr>
        <tr><td class="lbl">Visit Record</td><td class="val">✅ Archived</td></tr>
      </table>
    </div>

    <div class="tz">
      <strong>⏰ Timezone:</strong> All times in Indian Standard Time (IST – GMT+5:30).
      Email sent: ${now.timestamp}
    </div>
  </div>
  <div class="ftr">
    <img src="${p.logoUrl}" alt="Seeds FinCap">
    <p>Automated notification from Seeds FinCap Visitor Management System<br>
    © ${new Date().getFullYear()} Seeds Fincap Pvt. Ltd. All rights reserved.</p>
  </div>
</div>
</body>
</html>`;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided', code: 'NO_TOKEN' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(403).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
    next();
  };
}

// ── DB health middleware ──────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  const pub = [
    req.path === '/health',
    req.path === '/login',
    req.path === '/visitors' && req.method === 'POST',
    req.path === '/visitors/active' && req.method === 'GET',
    /^\/visitors\/\d+\/checkout\/public$/.test(req.path) && req.method === 'PUT'
  ];
  if (pub.some(Boolean)) return next();
  if (!sqlPool || !sqlPool.connected) return res.status(503).json({ error: 'Database unavailable', code: 'DATABASE_UNAVAILABLE' });
  next();
});

// ══════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════

// Health check
app.get('/api/health', async (req, res) => {
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: {},
    email: 'Resend HTTP API',
    environment: process.env.NODE_ENV || 'development'
  };
  if (sqlPool && sqlPool.connected) {
    try {
      await sqlPool.request().query('SELECT 1 AS test');
      health.database = { status: 'healthy', connected: true };
    } catch (e) {
      health.database = { status: 'unhealthy', error: e.message };
      health.status = 'DEGRADED';
    }
  } else {
    health.database = { status: 'disconnected' };
    health.status = 'DEGRADED';
  }
  res.json(health);
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required', code: 'MISSING_CREDENTIALS' });

    const request = sqlPool.request();
    request.input('username', sql.NVarChar, username);
    const result = await request.query(`
      SELECT id, username, email, password, role, COALESCE(is_active,1) as is_active
      FROM vs_users WHERE username=@username OR email=@username
    `);

    if (!result.recordset.length) {
      await bcrypt.compare(password, '$2b$10$dummyhashforpreventingtimingattacks');
      return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }

    const user = result.recordset[0];
    if (!user.is_active) return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });

    try {
      const upd = sqlPool.request();
      upd.input('userId', sql.Int, user.id);
      await upd.query('UPDATE vs_users SET last_login=GETDATE() WHERE id=@userId');
    } catch (_) {}

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── Create visitor (public — kiosk/reception) ────────────────────────────────
app.post('/api/visitors', async (req, res) => {
  try {
    const { visitor_name, mobile, host_employee, host_email, purpose, photo_base64 } = req.body;

    if (!visitor_name || !host_email || !purpose) {
      return res.status(400).json({ success: false, error: 'visitor_name, host_email and purpose are required', code: 'MISSING_FIELDS' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(host_email)) {
      return res.status(400).json({ success: false, error: 'Invalid host email format', code: 'INVALID_EMAIL' });
    }

    const qrId = `VIS-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const qrData = {
      id: qrId, name: visitor_name, mobile: mobile || '',
      host: host_employee || '', purpose,
      checkin: new Date().toISOString(), status: 'checked_in'
    };

    const qr = await generateQRCode(qrData);

    // Insert visitor
    const request = sqlPool.request();
    request.input('visitor_name', sql.NVarChar, visitor_name);
    request.input('mobile', sql.NVarChar, mobile || null);
    request.input('host_employee', sql.NVarChar, host_employee || null);
    request.input('host_email', sql.NVarChar, host_email);
    request.input('purpose', sql.NVarChar, purpose);
    request.input('qr_code_data', sql.NVarChar, JSON.stringify(qrData));
    request.input('created_by', sql.NVarChar, 'public_kiosk');

    let insertQuery = `
      INSERT INTO vs_visitors (visitor_name, mobile, host_employee, host_email, purpose, qr_code_data, created_by`;
    if (photo_base64) {
      request.input('photo_base64', sql.NVarChar, photo_base64);
      insertQuery += ', photo_base64';
    }
    insertQuery += `) OUTPUT INSERTED.id, INSERTED.checkin_time VALUES
      (@visitor_name, @mobile, @host_employee, @host_email, @purpose, @qr_code_data, @created_by`;
    if (photo_base64) insertQuery += ', @photo_base64';
    insertQuery += ')';

    const insertResult = await request.query(insertQuery);
    const visitorId = insertResult.recordset[0].id;
    const checkinTime = insertResult.recordset[0].checkin_time;

    const visitorDataForEmail = {
      visitor_name, mobile, host_employee, host_email, purpose,
      checkin_time: checkinTime, qr_id: qrId, visitor_id: visitorId
    };

    // ── Send email via Resend with CID attachments (works on all email clients) ──
    let emailSent = false;
    let emailError = null;

    try {
      // Build attachments — Resend CID inline images use contentId (camelCase)
      // HTML references them as src="cid:visitor-qr-code" / src="cid:visitor-photo"
      const attachments = [
        {
          filename: 'visitor-qr.png',
          content: qr.buffer.toString('base64'),
          content_type: 'image/png',
          contentId: 'visitor-qr-code'   // ← Resend's correct field (camelCase)
        }
      ];

      if (photo_base64) {
        attachments.push({
          filename: 'visitor-photo.jpg',
          content: photo_base64,
          content_type: 'image/jpeg',
          contentId: 'visitor-photo'     // ← matches cid:visitor-photo in HTML
        });
      }

      const { data, error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: [host_email],
        subject: `🛡️ New Visitor: ${visitor_name} - Seeds FinCap`,
        html: generateVisitorEmailHTML(visitorDataForEmail, !!photo_base64),
        attachments
      });

      if (error) throw new Error(typeof error === 'object' ? (error.message || JSON.stringify(error)) : error);
      emailSent = true;
      console.log(`✅ Resend email sent to ${host_email} | id: ${data?.id}`);
    } catch (emailErr) {
      emailError = emailErr.message || 'Failed to send email notification';
      console.error('❌ Resend error:', emailError);
    }

    res.json({
      success: true,
      id: visitorId,
      visitorId: qrId,
      qrCode: qr.dataURL,
      emailSent,
      emailError,
      message: emailSent
        ? 'Visitor checked-in successfully!'
        : 'Visitor checked-in, but email notification failed.',
      visitor: { name: visitor_name, host: host_employee, checkinTime, visitorId: qrId }
    });
  } catch (err) {
    console.error('Visitor creation error:', err);
    res.status(500).json({ success: false, error: 'Failed to create visitor', code: 'VISITOR_CREATION_ERROR', details: process.env.NODE_ENV === 'development' ? err.message : undefined });
  }
});

// ── Active visitors (public — for kiosk checkout) ───────────────────────────
app.get('/api/visitors/active', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const request = sqlPool.request();
    let query = `
      SELECT id, visitor_name, mobile, host_employee, host_email, purpose, checkin_time, status
      FROM vs_visitors
      WHERE status='checked_in' AND CAST(checkin_time AS DATE)=CAST(GETDATE() AS DATE)
    `;
    if (search) {
      request.input('search', sql.NVarChar, `%${search}%`);
      query += ` AND (visitor_name LIKE @search OR mobile LIKE @search OR host_employee LIKE @search)`;
    }
    query += ` ORDER BY checkin_time DESC`;
    const result = await request.query(query);
    res.json({
      success: true,
      count: result.recordset.length,
      visitors: result.recordset.map(v => ({
        ...v,
        checkin_time_ist: formatDateTimeIST(v.checkin_time, { fromDatabase: true }).timestamp
      }))
    });
  } catch (err) {
    console.error('Active visitors error:', err);
    res.status(500).json({ success: false, error: 'Failed to load active visitors', code: 'ACTIVE_VISITORS_ERROR' });
  }
});

// ── Shared checkout logic ─────────────────────────────────────────────────────
async function performVisitorCheckout(visitorId, checkoutBy) {
  const getReq = sqlPool.request();
  getReq.input('id', sql.Int, visitorId);
  const visitorResult = await getReq.query(`
    SELECT visitor_name, host_employee, host_email, checkin_time, status
    FROM vs_visitors WHERE id=@id
  `);

  if (!visitorResult.recordset.length) return { ok: false, status: 404, body: { success: false, error: 'Visitor not found', code: 'VISITOR_NOT_FOUND' } };
  const visitor = visitorResult.recordset[0];
  if (visitor.status === 'checked_out') return { ok: false, status: 400, body: { success: false, error: 'Visitor already checked out', code: 'ALREADY_CHECKED_OUT' } };

  const request = sqlPool.request();
  request.input('id', sql.Int, visitorId);
  request.input('checkoutBy', sql.NVarChar, checkoutBy);
  const result = await request.query(`
    UPDATE vs_visitors SET checkout_time=GETDATE(), status='checked_out'
    WHERE id=@id AND status='checked_in'
  `);

  if (result.rowsAffected[0] === 0) return { ok: false, status: 404, body: { success: false, error: 'Visitor not found or already checked out', code: 'VISITOR_NOT_FOUND' } };

  const checkoutTime = new Date();

  // Send checkout email via Resend
  if (visitor.host_email && process.env.SEND_CHECKOUT_EMAILS === 'true') {
    try {
      const { error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: [visitor.host_email],
        subject: `✅ Visitor Check-out: ${visitor.visitor_name} - Seeds FinCap`,
        html: generateCheckoutEmailHTML(visitor, checkoutTime)
      });
      if (error) throw new Error(typeof error === 'object' ? (error.message || JSON.stringify(error)) : error);
      console.log(`✅ Checkout email sent to ${visitor.host_email}`);
    } catch (emailErr) {
      console.error('❌ Checkout email error:', emailErr.message);
    }
  }

  return {
    ok: true,
    body: {
      success: true,
      message: 'Visitor checked out successfully',
      checkoutTime: checkoutTime.toISOString(),
      visitor: { id: visitorId, name: visitor.visitor_name, host: visitor.host_employee }
    }
  };
}

// Public checkout (kiosk — no auth)
app.put('/api/visitors/:id/checkout/public', async (req, res) => {
  try {
    const visitorId = parseInt(req.params.id);
    if (isNaN(visitorId)) return res.status(400).json({ success: false, error: 'Invalid visitor ID', code: 'INVALID_ID' });
    const outcome = await performVisitorCheckout(visitorId, 'reception_kiosk');
    res.status(outcome.ok ? 200 : outcome.status).json(outcome.body);
  } catch (err) {
    console.error('Public checkout error:', err);
    res.status(500).json({ success: false, error: 'Failed to check out visitor', code: 'CHECKOUT_ERROR' });
  }
});

// Admin checkout (authenticated)
app.put('/api/visitors/:id/checkout', authenticateToken, async (req, res) => {
  try {
    const visitorId = parseInt(req.params.id);
    if (isNaN(visitorId)) return res.status(400).json({ success: false, error: 'Invalid visitor ID', code: 'INVALID_ID' });
    const outcome = await performVisitorCheckout(visitorId, req.user.username);
    res.status(outcome.ok ? 200 : outcome.status).json(outcome.body);
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ success: false, error: 'Failed to check out visitor', code: 'CHECKOUT_ERROR' });
  }
});

// List visitors (authenticated)
app.get('/api/visitors', authenticateToken, async (req, res) => {
  try {
    const { date, status, host_email, page = 1, limit = 50, search } = req.query;
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const offset = (pageNum - 1) * limitNum;

    const request = sqlPool.request();
    let where = 'WHERE 1=1';

    if (date) { where += ' AND CAST(checkin_time AS DATE)=@date'; request.input('date', sql.Date, date); }
    if (status) { where += ' AND status=@status'; request.input('status', sql.NVarChar, status); }
    if (host_email) { where += ' AND host_email=@host_email'; request.input('host_email', sql.NVarChar, host_email); }
    if (search) { where += ' AND (visitor_name LIKE @search OR mobile LIKE @search OR host_employee LIKE @search)'; request.input('search', sql.NVarChar, `%${search}%`); }

    const countResult = await request.query(`SELECT COUNT(*) as total_count FROM vs_visitors ${where}`);
    const totalCount = countResult.recordset[0].total_count || 0;

    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limitNum);

    const result = await request.query(`
      SELECT id, visitor_name, mobile, host_employee, host_email, purpose,
             checkin_time, checkout_time, status, created_by
      FROM vs_visitors ${where}
      ORDER BY checkin_time DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    res.json({
      visitors: result.recordset,
      pagination: { page: pageNum, limit: limitNum, total: totalCount, pages: Math.ceil(totalCount / limitNum) }
    });
  } catch (err) {
    console.error('List visitors error:', err);
    res.status(500).json({ error: 'Failed to fetch visitors', code: 'FETCH_VISITORS_ERROR' });
  }
});

// Get visitor by ID
app.get('/api/visitors/:id', authenticateToken, async (req, res) => {
  try {
    const visitorId = parseInt(req.params.id);
    if (isNaN(visitorId)) return res.status(400).json({ error: 'Invalid visitor ID', code: 'INVALID_ID' });
    const request = sqlPool.request();
    request.input('id', sql.Int, visitorId);
    const result = await request.query(`
      SELECT id, visitor_name, mobile, host_employee, host_email, purpose,
             checkin_time, checkout_time, status, created_by, qr_code_data
      FROM vs_visitors WHERE id=@id
    `);
    if (!result.recordset.length) return res.status(404).json({ error: 'Visitor not found', code: 'VISITOR_NOT_FOUND' });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Get visitor error:', err);
    res.status(500).json({ error: 'Failed to fetch visitor', code: 'FETCH_VISITOR_ERROR' });
  }
});

// Admin stats
app.get('/api/admin/stats', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const request = sqlPool.request();
    const todayStats = await request.query(`
      SELECT
        COUNT(*) AS total_today,
        SUM(CASE WHEN status='checked_in' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status='checked_out' THEN 1 ELSE 0 END) AS checked_out,
        COUNT(DISTINCT host_email) AS unique_hosts
      FROM vs_visitors
      WHERE CAST(checkin_time AS DATE)=CAST(GETDATE() AS DATE)
    `);
    const weekStats = await request.query(`
      SELECT COUNT(*) AS total_week, CAST(checkin_time AS DATE) AS date, COUNT(*) AS daily_count
      FROM vs_visitors
      WHERE checkin_time>=DATEADD(day,-7,GETDATE())
      GROUP BY CAST(checkin_time AS DATE) ORDER BY date DESC
    `);
    const allTimeStats = await request.query(`
      SELECT COUNT(*) AS total_all, COUNT(DISTINCT host_email) AS total_hosts,
             MIN(checkin_time) AS first_visitor, MAX(checkin_time) AS last_visitor
      FROM vs_visitors
    `);
    res.json({ today: todayStats.recordset[0], week: weekStats.recordset, allTime: allTimeStats.recordset[0] });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch statistics', code: 'STATS_ERROR' });
  }
});

// Export CSV
app.get('/api/admin/export', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const request = sqlPool.request();
    let where = 'WHERE 1=1';
    if (startDate) { where += ' AND CAST(checkin_time AS DATE)>=@startDate'; request.input('startDate', sql.Date, startDate); }
    if (endDate) { where += ' AND CAST(checkin_time AS DATE)<=@endDate'; request.input('endDate', sql.Date, endDate); }
    if (!startDate && !endDate) where += ' AND checkin_time>=DATEADD(day,-7,GETDATE())';

    const result = await request.query(`
      SELECT id, visitor_name, mobile, host_employee, host_email, purpose,
             checkin_time, checkout_time, status, created_by
      FROM vs_visitors ${where} ORDER BY checkin_time DESC
    `);

    const headers = ['ID','Name','Mobile','Host','Email','Purpose','Check-in','Check-out','Status','Created By'];
    const rows = result.recordset.map(v => [
      v.id,
      `"${(v.visitor_name||'').replace(/"/g,'""')}"`,
      v.mobile || '',
      `"${(v.host_employee||'').replace(/"/g,'""')}"`,
      v.host_email || '',
      `"${(v.purpose||'').replace(/"/g,'""')}"`,
      v.checkin_time ? new Date(v.checkin_time).toISOString() : '',
      v.checkout_time ? new Date(v.checkout_time).toISOString() : '',
      v.status || '',
      v.created_by || ''
    ]);

    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const dateRange = startDate || endDate ? `${startDate||'start'}-to-${endDate||'today'}` : 'last-7-days';
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="Seeds-Visitors-${dateRange}.csv"`);
    res.send('\ufeff' + csv);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to generate export', code: 'EXPORT_ERROR' });
  }
});

// ── Error handlers ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR', message: process.env.NODE_ENV === 'development' ? err.message : undefined });
});
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' }));

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function gracefulShutdown() {
  console.log('🔄 Shutting down...');
  if (sqlPool) { try { await sqlPool.close(); console.log('✅ DB closed'); } catch (e) { console.error(e.message); } }
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3032;
initSqlConnection()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`
🚀 SEEDS VISITOR MANAGEMENT SYSTEM
==================================
✅ Server:      http://localhost:${PORT}
✅ Database:    ${process.env.DB_SERVER}:${process.env.DB_PORT}/${process.env.DB_NAME}
✅ Email:       Resend HTTP API (no SMTP ports — works on Render free tier)
✅ Admin:       ${process.env.ADMIN_EMAIL || 'admin@seedsfincap.com'}
✅ Environment: ${process.env.NODE_ENV || 'development'}
✅ Timezone:    IST (GMT+5:30)
==================================
📊 Admin:       http://localhost:${PORT}/admin.html
👤 Reception:   http://localhost:${PORT}/index.html
🔗 API Health:  http://localhost:${PORT}/api/health
==================================
      `);
    });
  })
  .catch(err => {
    console.error('❌ Failed to start:', err.message);
    process.exit(1);
  });