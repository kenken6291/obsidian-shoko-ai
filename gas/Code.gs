/**
 * Obsidian書庫AI — GASバックエンド (Code.gs)
 * Version: v1.1.0（Gemini 4 対応・モデル自動フォールバック）
 *
 * フロントエンド(GitHub Pages)から text/plain の JSON を POST で受け取り、JSON を返す Web API。
 *   リクエスト: { action: "login", token: "...", ...params }
 *   レスポンス: { ok: true, ... } / { ok: false, error: "メッセージ", code: "AUTH" など }
 *
 * 初回は setup() を実行してください（シート作成・既定プロパティ設定・定期索引トリガー登録）。
 * APIキーは必ず「スクリプトプロパティ」に保存し、コードやGitHubには含めないこと。
 */

const APP_VERSION = 'v1.1.0';
const PROPS = PropertiesService.getScriptProperties();

const SHEET_DEFS = {
  Users: ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'mustChangePassword', 'status', 'role',
    'failedCount', 'lockedUntil', 'agreedAt', 'createdAt', 'updatedAt', 'lastLoginAt'],
  Sessions: ['token', 'userId', 'createdAt', 'expiresAt'],
  Cards: ['cardId', 'ownerId', 'title', 'question', 'answer', 'narration', 'sources', 'places',
    'isShared', 'sharedWith', 'createdAt', 'updatedAt'],
  NoteIndex: ['fileId', 'path', 'title', 'tags', 'modified', 'size', 'content', 'indexedAt'],
  Logs: ['timestamp', 'userId', 'action', 'detail']
};

const DEFAULT_PROPS = {
  APP_NAME: 'Obsidian書庫AI',
  GEMINI_MODEL: 'gemini-4-hydrogen',            // 回答・解析（Geminiアプリの「4 Hydrogen」）
  GEMINI_MODEL_FALLBACK: 'gemini-3.8-flash',     // 上が使えない時の予備（空欄で無効）
  GEMINI_THINKING_LEVEL: 'medium',               // 回答時の思考レベル low / medium / high（Gemini 4 は xhigh も可）
  GEMINI_TTS_MODEL: 'gemini-3.8-flash-tts',      // 読み上げ
  GEMINI_TTS_MODEL_FALLBACK: 'gemini-2.5-flash-preview-tts',
  GEMINI_TTS_VOICE: 'Kore',
  SESSION_HOURS: '168',
  MAX_NOTES: '8',
  MAX_CONTEXT_CHARS: '60000',
  EXCLUDE_FOLDERS: '.obsidian,.trash,.git,node_modules',
  SEARCH_ALLOWED: 'all'
};

const HASH_ITERATIONS = 300;
const MAX_LOGIN_FAILS = 5;
const LOCK_MINUTES = 15;
const NOTE_CONTENT_MAX = 45000; // セル上限 50,000 文字に対する余裕

/* =========================================================
 * エントリーポイント
 * ========================================================= */

function doGet() {
  return json_({ ok: true, app: prop_('APP_NAME'), version: APP_VERSION, message: 'API is running. Use POST.' });
}

function doPost(e) {
  let res;
  try {
    const body = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const req = JSON.parse(body);
    res = route_(req);
  } catch (err) {
    if (err && err.userMessage) {
      res = { ok: false, error: err.userMessage, code: err.code || 'ERROR' };
    } else {
      console.error(err && err.stack ? err.stack : err);
      res = { ok: false, error: 'サーバーエラーが発生しました: ' + (err && err.message ? err.message : err), code: 'SERVER' };
    }
  }
  return json_(res);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  const action = String(req.action || '');
  // --- 認証不要 ---
  const publicActions = {
    ping: () => ({ ok: true, version: APP_VERSION, app: prop_('APP_NAME') }),
    register: () => actionRegister_(req),
    login: () => actionLogin_(req),
    forgotPassword: () => actionForgot_(req)
  };
  if (publicActions[action]) return publicActions[action]();

  // --- ログイン必須（仮パスワード状態でも可） ---
  const user = requireUser_(req.token);
  const semiActions = {
    me: () => ({ ok: true, user: userToClient_(user) }),
    logout: () => actionLogout_(req),
    changePassword: () => actionChangePassword_(user, req)
  };
  if (semiActions[action]) return semiActions[action]();

  // --- 本パスワード設定済みのみ ---
  if (toBool_(user.mustChangePassword)) {
    throw appError_('パスワードの変更が必要です。', 'MUST_CHANGE');
  }
  const actions = {
    ask: () => actionAsk_(user, req),
    listMyCards: () => actionListMyCards_(user),
    listSharedCards: () => actionListSharedCards_(user),
    getCard: () => actionGetCard_(user, req),
    updateSharing: () => actionUpdateSharing_(user, req),
    deleteCard: () => actionDeleteCard_(user, req),
    listMembers: () => actionListMembers_(user),
    tts: () => actionTts_(user, req),
    indexStatus: () => actionIndexStatus_(user),
    reindex: () => actionReindex_(user, req)
  };
  if (actions[action]) return actions[action]();
  throw appError_('不明な操作です: ' + action, 'BAD_REQUEST');
}

/* =========================================================
 * 共通ユーティリティ
 * ========================================================= */

function appError_(msg, code) {
  const e = new Error(msg);
  e.userMessage = msg;
  e.code = code || 'ERROR';
  return e;
}

function prop_(key, fallback) {
  const v = PROPS.getProperty(key);
  if (v !== null && v !== '') return v;
  if (fallback !== undefined) return fallback;
  return DEFAULT_PROPS[key] !== undefined ? DEFAULT_PROPS[key] : '';
}

function nowIso_() { return new Date().toISOString(); }

function toBool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function parseJson_(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

function bytesToHex_(bytes) {
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function randomBytes_() {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + ':' + Date.now() + ':' + Math.random() + ':' + Utilities.getUuid());
}

function randomToken_() {
  return bytesToHex_(randomBytes_()) + bytesToHex_(randomBytes_()).slice(0, 16);
}

function getSpreadsheet_() {
  const id = prop_('SPREADSHEET_ID', '');
  if (!id) throw appError_('SPREADSHEET_ID が未設定です。GASで setup() を実行してください。', 'CONFIG');
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  const sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw appError_('シート「' + name + '」がありません。setup() を実行してください。', 'CONFIG');
  return sh;
}

/** シート全行をオブジェクト配列で返す（_row = 実際の行番号） */
function readRows_(name) {
  const sh = getSheet_(name);
  const last = sh.getLastRow();
  const headers = SHEET_DEFS[name];
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values.map((row, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, j) => {
      const v = row[j];
      if (v === null || v === undefined) o[h] = '';
      else if (v instanceof Date) o[h] = v.toISOString();
      else o[h] = String(v).replace(/^\u200B/, '');
    });
    return o;
  }).filter(o => o[headers[0]] !== '');
}

function objToRow_(name, obj) {
  return SHEET_DEFS[name].map(h => {
    const v = (obj[h] === undefined || obj[h] === null) ? '' : String(obj[h]);
    // 数式として解釈されないよう、先頭が = + - @ の文字列にはゼロ幅スペースを付与（読込時に除去）
    return /^[=+\-@]/.test(v) ? '\u200B' + v : v;
  });
}

function appendObj_(name, obj) {
  getSheet_(name).appendRow(objToRow_(name, obj));
}

function updateObj_(name, obj) {
  if (!obj._row) throw new Error('row missing');
  const sh = getSheet_(name);
  sh.getRange(obj._row, 1, 1, SHEET_DEFS[name].length).setValues([objToRow_(name, obj)]);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw appError_('混み合っています。少し待ってから再度お試しください。', 'BUSY');
  try { return fn(); } finally { lock.releaseLock(); }
}

function log_(userId, action, detail) {
  try {
    appendObj_('Logs', { timestamp: nowIso_(), userId: userId || '', action: action, detail: String(detail || '').slice(0, 1000) });
  } catch (e) { console.warn('log failed', e); }
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function maskEmail_(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '***';
  const head = name.slice(0, Math.min(2, name.length));
  return head + '***@' + domain;
}

/* =========================================================
 * パスワード・セッション
 * ========================================================= */

function hashPassword_(password, salt) {
  const pepper = prop_('PASSWORD_PEPPER', '');
  let hex = '';
  for (let i = 0; i < HASH_ITERATIONS; i++) {
    hex = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      hex + '|' + salt + '|' + password + '|' + pepper, Utilities.Charset.UTF_8));
  }
  return hex;
}

function generateTempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    const bytes = randomBytes_();
    let pw = '';
    for (let i = 0; i < 10; i++) pw += chars[(bytes[i] & 0xff) % chars.length];
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

function validateNewPassword_(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'パスワードは8文字以上にしてください。';
  if (pw.length > 64) return 'パスワードは64文字以内にしてください。';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'パスワードは英字と数字を両方含めてください。';
  return '';
}

function createSession_(userId) {
  const token = randomToken_();
  const hours = Number(prop_('SESSION_HOURS')) || 168;
  const now = new Date();
  appendObj_('Sessions', {
    token: token, userId: userId, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 3600 * 1000).toISOString()
  });
  CacheService.getScriptCache().put('sess:' + token, userId, 21600);
  return token;
}

function requireUser_(token) {
  if (!token) throw appError_('ログインしてください。', 'AUTH');
  const cache = CacheService.getScriptCache();
  let userId = cache.get('sess:' + token);
  if (!userId) {
    const s = readRows_('Sessions').find(r => r.token === token);
    if (!s || new Date(s.expiresAt).getTime() < Date.now()) {
      throw appError_('ログインの有効期限が切れました。もう一度ログインしてください。', 'AUTH');
    }
    userId = s.userId;
    cache.put('sess:' + token, userId, 21600);
  }
  const user = readRows_('Users').find(u => u.userId === userId);
  if (!user || user.status === 'disabled') {
    cache.remove('sess:' + token);
    throw appError_('このアカウントは利用できません。', 'AUTH');
  }
  return user;
}

function cleanupSessions_() {
  const sh = getSheet_('Sessions');
  const rows = readRows_('Sessions');
  const now = Date.now();
  // 下から削除（行ずれ防止）
  rows.filter(r => new Date(r.expiresAt).getTime() < now)
    .sort((a, b) => b._row - a._row)
    .forEach(r => sh.deleteRow(r._row));
}

function isAdmin_(user) {
  if (user.role === 'admin') return true;
  const admins = prop_('ADMIN_EMAILS', '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return admins.indexOf(String(user.email).toLowerCase()) >= 0;
}

function canSearch_(user) {
  return prop_('SEARCH_ALLOWED') !== 'admin' || isAdmin_(user);
}

function userToClient_(u) {
  return {
    userId: u.userId, email: u.email, nickname: u.nickname,
    mustChangePassword: toBool_(u.mustChangePassword),
    isAdmin: isAdmin_(u), canSearch: canSearch_(u)
  };
}

/* =========================================================
 * 会員認証アクション
 * ========================================================= */

function actionRegister_(req) {
  const email = String(req.email || '').trim().toLowerCase();
  const nickname = String(req.nickname || '').trim();
  if (!isValidEmail_(email)) throw appError_('メールアドレスの形式が正しくありません。', 'VALIDATION');
  if (!nickname || nickname.length > 30) throw appError_('ニックネームは1〜30文字で入力してください。', 'VALIDATION');
  if (req.agreed !== true) throw appError_('注意書き・免責事項への同意が必要です。', 'VALIDATION');

  const cache = CacheService.getScriptCache();
  if (cache.get('reg:' + email)) throw appError_('短時間に繰り返し登録できません。1分ほど待ってください。', 'RATE');

  const tempPw = generateTempPassword_();
  withLock_(() => {
    const users = readRows_('Users');
    if (users.some(u => u.email === email)) {
      throw appError_('このメールアドレスは登録済みです。「パスワードを忘れた方」から再発行できます。', 'DUPLICATE');
    }
    const salt = randomToken_().slice(0, 32);
    const now = nowIso_();
    appendObj_('Users', {
      userId: 'u_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16),
      email: email, nickname: nickname,
      passwordHash: hashPassword_(tempPw, salt), salt: salt,
      mustChangePassword: 'TRUE', status: 'active',
      role: users.length === 0 ? 'admin' : 'member', // 最初の登録者を管理者にする
      failedCount: '0', lockedUntil: '', agreedAt: now,
      createdAt: now, updatedAt: now, lastLoginAt: ''
    });
  });
  cache.put('reg:' + email, '1', 60);
  sendTempPasswordMail_(email, nickname, tempPw, false);
  log_('', 'register', email);
  return { ok: true, message: '仮パスワードを ' + email + ' に送信しました。メールを確認してログインしてください。' };
}

function actionLogin_(req) {
  const email = String(req.email || '').trim().toLowerCase();
  const password = String(req.password || '');
  const generic = 'メールアドレスまたはパスワードが違います。';
  if (!email || !password) throw appError_(generic, 'AUTH_FAILED');

  return withLock_(() => {
    const user = readRows_('Users').find(u => u.email === email);
    if (!user) throw appError_(generic, 'AUTH_FAILED');
    if (user.status === 'disabled') throw appError_('このアカウントは停止されています。', 'AUTH_FAILED');
    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      throw appError_('ログインに連続で失敗したため、一時的にロックされています。' + LOCK_MINUTES + '分ほど待ってから再度お試しください。', 'LOCKED');
    }
    if (hashPassword_(password, user.salt) !== user.passwordHash) {
      const fails = (Number(user.failedCount) || 0) + 1;
      user.failedCount = String(fails);
      if (fails >= MAX_LOGIN_FAILS) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
        user.failedCount = '0';
      }
      user.updatedAt = nowIso_();
      updateObj_('Users', user);
      throw appError_(generic, 'AUTH_FAILED');
    }
    user.failedCount = '0';
    user.lockedUntil = '';
    user.lastLoginAt = nowIso_();
    updateObj_('Users', user);
    if (Math.random() < 0.2) cleanupSessions_();
    const token = createSession_(user.userId);
    log_(user.userId, 'login', '');
    return { ok: true, token: token, user: userToClient_(user) };
  });
}

function actionLogout_(req) {
  const token = String(req.token || '');
  CacheService.getScriptCache().remove('sess:' + token);
  withLock_(() => {
    const s = readRows_('Sessions').find(r => r.token === token);
    if (s) getSheet_('Sessions').deleteRow(s._row);
  });
  return { ok: true };
}

function actionChangePassword_(user, req) {
  const current = String(req.currentPassword || '');
  const next = String(req.newPassword || '');
  if (hashPassword_(current, user.salt) !== user.passwordHash) {
    throw appError_('現在のパスワード（仮パスワード）が違います。', 'VALIDATION');
  }
  const err = validateNewPassword_(next);
  if (err) throw appError_(err, 'VALIDATION');
  if (next === current) throw appError_('現在と同じパスワードは使えません。', 'VALIDATION');
  withLock_(() => {
    const fresh = readRows_('Users').find(u => u.userId === user.userId);
    const salt = randomToken_().slice(0, 32);
    fresh.salt = salt;
    fresh.passwordHash = hashPassword_(next, salt);
    fresh.mustChangePassword = 'FALSE';
    fresh.updatedAt = nowIso_();
    updateObj_('Users', fresh);
    user.mustChangePassword = 'FALSE';
  });
  log_(user.userId, 'changePassword', '');
  return { ok: true, user: userToClient_(user), message: 'パスワードを変更しました。' };
}

function actionForgot_(req) {
  const email = String(req.email || '').trim().toLowerCase();
  const msg = 'ご入力のメールアドレスが登録されている場合、新しい仮パスワードを送信しました。';
  if (!isValidEmail_(email)) throw appError_('メールアドレスの形式が正しくありません。', 'VALIDATION');
  const cache = CacheService.getScriptCache();
  if (cache.get('fp:' + email)) return { ok: true, message: msg };
  cache.put('fp:' + email, '1', 60);

  let target = null, tempPw = '';
  withLock_(() => {
    const user = readRows_('Users').find(u => u.email === email);
    if (!user || user.status === 'disabled') return;
    tempPw = generateTempPassword_();
    const salt = randomToken_().slice(0, 32);
    user.salt = salt;
    user.passwordHash = hashPassword_(tempPw, salt);
    user.mustChangePassword = 'TRUE';
    user.failedCount = '0';
    user.lockedUntil = '';
    user.updatedAt = nowIso_();
    updateObj_('Users', user);
    target = user;
  });
  if (target) {
    sendTempPasswordMail_(target.email, target.nickname, tempPw, true);
    log_(target.userId, 'forgotPassword', '');
  }
  return { ok: true, message: msg };
}

function sendTempPasswordMail_(email, nickname, tempPw, isReset) {
  const appName = prop_('APP_NAME');
  const url = prop_('APP_URL', '');
  const subject = '【' + appName + '】' + (isReset ? '仮パスワード再発行のお知らせ' : 'ご登録ありがとうございます（仮パスワードのお知らせ）');
  const body = [
    nickname + ' さん',
    '',
    isReset ? 'パスワード再発行のご依頼を受け付けました。' : appName + ' へのご登録ありがとうございます。',
    '以下の仮パスワードでログインしてください。',
    '',
    '　仮パスワード： ' + tempPw,
    '',
    'ログイン後、ご自身で決めた本パスワードへの変更をお願いします。',
    '（変更が完了するまで、検索などの機能はご利用いただけません）',
    url ? '\nログインはこちら： ' + url : '',
    '',
    '※このメールにお心当たりがない場合は、破棄してください。',
    '※本メールは送信専用です。',
    '',
    '―― ' + appName
  ].join('\n');
  MailApp.sendEmail({ to: email, subject: subject, body: body, name: appName });
}

/* =========================================================
 * Gemini API（キーの優先順位フォールバック）
 * ========================================================= */

function getApiKeys_() {
  return ['GEMINI_API_KEY_1', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3']
    .map(name => ({ name: name, key: prop_(name, '') }))
    .filter(k => k.key);
}

function isRetryable_(code, body) {
  if ([401, 403, 429, 500, 502, 503, 504].indexOf(code) >= 0) return true;
  if (code === 400 && /API key|API_KEY_INVALID|expired|billing/i.test(body)) return true;
  if (code === 404 && /model/i.test(body)) return false;
  return false;
}

/**
 * 第1→第2→第3優先キーの順に試行。429（レート制限）や利用不可エラーで次のキーへ。
 */
function callGemini_(model, payload) {
  const keys = getApiKeys_();
  if (!keys.length) throw appError_('Gemini APIキーが未設定です（スクリプトプロパティ GEMINI_API_KEY_1）。', 'CONFIG');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const errors = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    let resp;
    try {
      resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': k.key },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    } catch (e) {
      errors.push(k.name + ': 通信エラー');
      continue;
    }
    const code = resp.getResponseCode();
    const text = resp.getContentText();
    if (code === 200) {
      if (i > 0) log_('', 'geminiFallback', model + ' → ' + k.name + ' で成功 / ' + errors.join(' | '));
      return JSON.parse(text);
    }
    let detail = '';
    try { detail = JSON.parse(text).error.message; } catch (e) { detail = text.slice(0, 200); }
    errors.push(k.name + ': HTTP ' + code);
    console.warn('Gemini error', k.name, code, detail);
    if (!isRetryable_(code, text)) {
      const err = appError_('Gemini APIエラー（' + model + ' / HTTP ' + code + '）: ' + detail, 'GEMINI_REQUEST');
      err.httpCode = code;
      throw err;
    }
  }
  log_('', 'geminiAllKeysFailed', model + ' / ' + errors.join(' | '));
  throw appError_('AIが混み合っているか、すべてのAPIキーで利用できませんでした。時間をおいて再度お試しください。（' + model + ': ' + errors.join(' / ') + '）', 'GEMINI');
}

/** モデル名がGemini 3/4系か（thinkingLevel を送れるか） */
function supportsThinkingLevel_(model) {
  return /^gemini-(3|4)/i.test(model) && !/tts|image|live/i.test(model);
}

/**
 * モデルの優先順位フォールバック付き呼び出し。
 *   kind: 'text' → GEMINI_MODEL → GEMINI_MODEL_FALLBACK
 *         'tts'  → GEMINI_TTS_MODEL → GEMINI_TTS_MODEL_FALLBACK
 *   opts.thinkingLevel: Gemini 3/4 系にだけ thinkingConfig.thinkingLevel を付ける
 * 各モデル内では APIキー 1→2→3 の順に試行（callGemini_）。
 * 400 エラー時は、思考設定・JSONスキーマを外して同じモデルで1回だけ再試行してから次のモデルへ。
 */
function geminiGenerate_(kind, payload, opts) {
  opts = opts || {};
  const models = (kind === 'tts'
    ? [prop_('GEMINI_TTS_MODEL'), prop_('GEMINI_TTS_MODEL_FALLBACK')]
    : [prop_('GEMINI_MODEL'), prop_('GEMINI_MODEL_FALLBACK')])
    .map(m => String(m || '').trim())
    .filter((m, i, arr) => m && arr.indexOf(m) === i);
  if (!models.length) throw appError_('Geminiのモデル名が未設定です。', 'CONFIG');

  let lastErr = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const body = JSON.parse(JSON.stringify(payload));
    if (kind !== 'tts') {
      body.generationConfig = body.generationConfig || {};
      if (opts.thinkingLevel && supportsThinkingLevel_(model)) {
        body.generationConfig.thinkingConfig = { thinkingLevel: String(opts.thinkingLevel).toLowerCase() };
      }
    }
    try {
      const resp = callGemini_(model, body);
      if (i > 0) log_('', 'geminiModelFallback', models[0] + ' → ' + model + ' / ' + (lastErr ? lastErr.userMessage : ''));
      resp._model = model;
      return resp;
    } catch (e) {
      lastErr = e;
      if (!e || !/^GEMINI/.test(e.code || '')) throw e;
      // 400: パラメータ非対応の可能性 → 簡素化して同じモデルで再試行
      if (e.httpCode === 400 && kind !== 'tts') {
        const simple = JSON.parse(JSON.stringify(body));
        if (simple.generationConfig) {
          delete simple.generationConfig.thinkingConfig;
          delete simple.generationConfig.responseSchema;
          delete simple.generationConfig.temperature;
        }
        try {
          const resp2 = callGemini_(model, simple);
          log_('', 'geminiSimplified', model + ' / ' + e.userMessage);
          resp2._model = model;
          return resp2;
        } catch (e2) {
          lastErr = e2;
          if (!e2 || !/^GEMINI/.test(e2.code || '')) throw e2;
        }
      }
      console.warn('model failed, next:', model, e.userMessage);
    }
  }
  throw lastErr;
}

function extractText_(resp) {
  const cand = resp && resp.candidates && resp.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) {
    const reason = (resp && resp.promptFeedback && resp.promptFeedback.blockReason) || (cand && cand.finishReason) || '不明';
    throw appError_('AIから回答を得られませんでした（理由: ' + reason + '）。', 'GEMINI');
  }
  return cand.content.parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
}

function parseJsonLoose_(text) {
  try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
  const m = String(text).replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* fallthrough */ } }
  return null;
}

/* =========================================================
 * Obsidian書庫の索引（NoteIndexシート）
 * ========================================================= */

/** 定期トリガー用：変更されたノートだけを読み直す差分更新 */
function buildIndex() { return buildIndex_(false); }

/** 手動用：全ノートを読み直す */
function rebuildIndexFull() { return buildIndex_(true); }

function buildIndex_(full) {
  const folderId = prop_('VAULT_FOLDER_ID', '');
  if (!folderId) throw appError_('VAULT_FOLDER_ID が未設定です。', 'CONFIG');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: '別の索引更新が実行中です。' };
  try {
    const start = Date.now();
    const TIME_LIMIT = 4.5 * 60 * 1000;
    const exclude = prop_('EXCLUDE_FOLDERS').split(',').map(s => s.trim()).filter(Boolean);
    const files = [];
    walkFolder_(DriveApp.getFolderById(folderId), '', files, exclude);

    const sh = getSheet_('NoteIndex');
    const existing = {};
    readRows_('NoteIndex').forEach(r => { existing[r.fileId] = r; });

    const out = [];
    let readCount = 0, keptCount = 0, pending = 0;
    files.forEach(f => {
      const old = existing[f.id];
      const unchanged = old && Number(old.modified) === f.modified && old.path === f.path;
      if (!full && unchanged) { out.push(objToRow_('NoteIndex', old)); keptCount++; return; }
      if (Date.now() - start > TIME_LIMIT) {
        if (old) out.push(objToRow_('NoteIndex', old));
        pending++;
        return;
      }
      let content = '';
      try { content = f.file.getBlob().getDataAsString('UTF-8'); } catch (e) { content = ''; }
      out.push(objToRow_('NoteIndex', {
        fileId: f.id, path: f.path, title: f.name.replace(/\.md$/i, ''),
        tags: parseTags_(content).join(','),
        modified: String(f.modified), size: String(f.size),
        content: content.slice(0, NOTE_CONTENT_MAX), indexedAt: nowIso_()
      }));
      readCount++;
    });

    // 書き込み（全置換）
    const cols = SHEET_DEFS.NoteIndex.length;
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, cols).clearContent();
    const BATCH = 200;
    for (let i = 0; i < out.length; i += BATCH) {
      const chunk = out.slice(i, i + BATCH);
      sh.getRange(2 + i, 1, chunk.length, cols).setValues(chunk);
    }
    const summary = {
      total: out.length, read: readCount, kept: keptCount, pending: pending,
      seconds: Math.round((Date.now() - start) / 1000), at: nowIso_()
    };
    PROPS.setProperty('INDEX_LAST_RUN', JSON.stringify(summary));
    console.log('buildIndex', JSON.stringify(summary));
    return { ok: true, summary: summary };
  } finally {
    lock.releaseLock();
  }
}

function walkFolder_(folder, prefix, out, exclude) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (!/\.md$/i.test(name)) continue;
    out.push({
      file: file, id: file.getId(), name: name, path: prefix + name,
      modified: file.getLastUpdated().getTime(), size: file.getSize()
    });
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    const name = sub.getName();
    if (exclude.indexOf(name) >= 0) continue;
    walkFolder_(sub, prefix + name + '/', out, exclude);
  }
}

function parseTags_(content) {
  const tags = {};
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const lines = fm[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(tags|tag|aliases)\s*:\s*(.*)$/i);
      if (!m) continue;
      if (m[2].trim()) {
        m[2].replace(/[\[\]"']/g, '').split(/[,\s]+/).forEach(t => { if (t) tags[t.replace(/^#/, '')] = 1; });
      } else {
        for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) {
          const t = lines[j].replace(/^\s*-\s+/, '').replace(/["']/g, '').trim();
          if (t) tags[t.replace(/^#/, '')] = 1;
        }
      }
    }
  }
  const inline = content.match(/(?:^|\s)#([^\s#.,;:!?()\[\]{}「」、。]{1,40})/g) || [];
  inline.forEach(t => {
    const tag = t.trim().replace(/^#/, '');
    if (tag && !/^\d+$/.test(tag)) tags[tag] = 1;
  });
  return Object.keys(tags).slice(0, 30);
}

/* =========================================================
 * 検索・回答生成
 * ========================================================= */

function localKeywords_(q) {
  const stop = ['について', '教えて', 'ください', 'とは', 'なに', '何', 'どう', 'どこ', 'いつ', 'こと', 'もの',
    'ため', 'よう', 'です', 'ます', 'ある', 'いる', 'する', 'した', 'まとめ', 'まとめて', '知りたい'];
  const set = {};
  (q.match(/[一-龠々ヶ]{2,}|[ァ-ヴー]{2,}|[A-Za-z0-9][A-Za-z0-9_\-]{1,}/g) || []).forEach(w => {
    if (stop.indexOf(w) < 0) set[w] = 1;
  });
  return Object.keys(set).slice(0, 8);
}

function analyzeQuery_(q) {
  try {
    const resp = geminiGenerate_('text', {
      contents: [{ role: 'user', parts: [{ text:
        '次の質問に答えるため、個人のObsidianノート（Markdown）を全文検索します。\n' +
        '検索に使うキーワードを抽出してください。\n' +
        '- keywords: 質問中の重要語（名詞中心・固有名詞は必ず含める）3〜6個\n' +
        '- related: 同義語・表記ゆれ（漢字/かな/カタカナ/英語）・関連語 最大8個\n' +
        '質問: ' + q }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            keywords: { type: 'ARRAY', items: { type: 'STRING' } },
            related: { type: 'ARRAY', items: { type: 'STRING' } }
          },
          required: ['keywords']
        }
      }
    }, { thinkingLevel: 'low' });
    const parsed = parseJsonLoose_(extractText_(resp));
    if (parsed && parsed.keywords && parsed.keywords.length) {
      return {
        keywords: parsed.keywords.map(String).filter(Boolean).slice(0, 8),
        related: (parsed.related || []).map(String).filter(Boolean).slice(0, 10)
      };
    }
  } catch (e) {
    console.warn('analyzeQuery fallback', e.message);
  }
  return { keywords: localKeywords_(q), related: [] };
}

function countOccurrences_(haystack, needle) {
  if (!needle) return 0;
  let count = 0, pos = haystack.indexOf(needle);
  while (pos >= 0 && count < 30) { count++; pos = haystack.indexOf(needle, pos + needle.length); }
  return count;
}

function searchNotes_(q, analysis) {
  const rows = readRows_('NoteIndex');
  if (!rows.length) throw appError_('書庫の索引がまだありません。管理者が「索引を更新」を実行してください。', 'NO_INDEX');
  const terms = [];
  analysis.keywords.forEach(k => terms.push({ t: k.toLowerCase(), w: 1 }));
  analysis.related.forEach(k => terms.push({ t: k.toLowerCase(), w: 0.5 }));
  localKeywords_(q).forEach(k => {
    if (!terms.some(x => x.t === k.toLowerCase())) terms.push({ t: k.toLowerCase(), w: 0.4 });
  });

  const scored = rows.map(r => {
    const title = r.title.toLowerCase(), path = r.path.toLowerCase(), tags = r.tags.toLowerCase();
    const content = r.content.toLowerCase();
    let score = 0, distinct = 0;
    terms.forEach(x => {
      if (!x.t || x.t.length < 2 && !/[一-龠]/.test(x.t)) return;
      let s = 0;
      if (title.indexOf(x.t) >= 0) s += 12;
      if (tags.indexOf(x.t) >= 0) s += 6;
      if (path.indexOf(x.t) >= 0) s += 3;
      s += Math.min(countOccurrences_(content, x.t), 20);
      if (s > 0) distinct++;
      score += s * x.w;
    });
    if (distinct > 1) score *= (1 + 0.3 * (distinct - 1));
    return { row: r, score: score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score || Number(b.row.modified) - Number(a.row.modified));
  const maxNotes = Number(prop_('MAX_NOTES')) || 8;
  return { notes: scored.slice(0, maxNotes).map(x => x.row), terms: terms.map(x => x.t) };
}

function buildContext_(notes, terms) {
  const maxTotal = Number(prop_('MAX_CONTEXT_CHARS')) || 60000;
  const perNote = Math.max(2500, Math.floor(maxTotal / Math.max(notes.length, 1)));
  let total = 0;
  const blocks = [];
  notes.forEach(n => {
    if (total >= maxTotal) return;
    const content = n.content;
    const lower = content.toLowerCase();
    const ranges = [];
    terms.forEach(t => {
      if (!t) return;
      let pos = lower.indexOf(t), c = 0;
      while (pos >= 0 && c < 8) {
        ranges.push([Math.max(0, pos - 300), Math.min(content.length, pos + t.length + 500)]);
        pos = lower.indexOf(t, pos + t.length); c++;
      }
    });
    let excerpt;
    if (!ranges.length || content.length <= perNote) {
      excerpt = content.slice(0, perNote);
    } else {
      ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      ranges.forEach(r => {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice());
      });
      excerpt = merged.map(r => content.slice(r[0], r[1])).join('\n…\n').slice(0, perNote);
    }
    const block = '### ノート名: ' + n.title + '\nパス: ' + n.path + (n.tags ? '\nタグ: ' + n.tags : '') +
      '\n---\n' + excerpt + '\n';
    total += block.length;
    blocks.push(block);
  });
  return blocks.join('\n');
}

function generateAnswer_(q, context) {
  const system = [
    'あなたは利用者個人のObsidian書庫（メモ・ノート）を調べて答えるアシスタントです。',
    '必ず【ノート抜粋】の内容だけを根拠に、日本語でわかりやすく答えてください。',
    'ノートに書かれていないことは推測で補わず、「ノートには記載がありません」と明記してください。',
    '',
    '出力ルール:',
    '- title: 回答の内容を表す短いタイトル（30文字以内）',
    '- answer: Markdownで書いた回答本文。見出し・箇条書きを適宜使い、根拠にした箇所の文末に【出典: ノート名】を付ける。最後に「## 出典ノート」として使用したノート名を箇条書きで列挙する。',
    '- narration: 音声で読み上げるための純粋な本文のみ。です・ます調の自然な話し言葉。記号・Markdown・URL・絵文字・出典表記・括弧書きのト書きを含めない。「はい」「以下の文章を読み上げます」「〜で読み上げてください」のような前置きやメタ発言、話し方の指示は絶対に書かない。600文字程度まで。',
    '- sources: 実際に根拠として使ったノート名（抜粋の「ノート名」と完全一致）',
    '- places: 回答に具体的な地名・史跡・施設・旅行先が含まれる場合のみ、その場所の名称と緯度経度（あなたの知識による概算、10進数）と一言説明。地理情報がなければ空配列。最大8件。'
  ].join('\n');

  const resp = geminiGenerate_('text', {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: '【質問】\n' + q + '\n\n【ノート抜粋】\n' + context }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          answer: { type: 'STRING' },
          narration: { type: 'STRING' },
          sources: { type: 'ARRAY', items: { type: 'STRING' } },
          places: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                lat: { type: 'NUMBER' },
                lng: { type: 'NUMBER' },
                description: { type: 'STRING' }
              },
              required: ['name', 'lat', 'lng']
            }
          }
        },
        required: ['title', 'answer', 'narration', 'sources', 'places']
      }
    }
  }, { thinkingLevel: prop_('GEMINI_THINKING_LEVEL') });
  const text = extractText_(resp);
  const parsed = parseJsonLoose_(text);
  if (!parsed || !parsed.answer) {
    return { title: q.slice(0, 30), answer: text, narration: '', sources: [], places: [], _model: resp._model };
  }
  parsed._model = resp._model;
  return parsed;
}

/**
 * 読み上げ用テキストの前処理：メタ発言・ト書き・記号類を除去して純粋な本文だけにする
 * （フロントエンド app.js の cleanNarration と同じ規則）
 */
function cleanNarration_(text) {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/【出典[^】]*】/g, '');
  s = s.replace(/[（(]\s*出典[^）)]*[）)]/g, '');
  // メタ発言・前置き
  s = s.replace(/^\s*(はい|了解です|了解しました|承知しました|かしこまりました|わかりました)[、。！!]?\s*/g, '');
  s = s.replace(/[^。！？!?\n]*(以下|次|こちら)の(文章|テキスト|内容|原稿|ナレーション)を[^。！？!?\n]*(読み上げ|お読み|朗読)[^。！？!?\n]*[。！!]?/g, '');
  s = s.replace(/[^。！？!?\n]*(読み上げて|朗読して|ナレーションして)(ください|下さい)[^。！？!?\n]*[。！!]?/g, '');
  s = s.replace(/[^。！？!?\n]*(読み上げます|朗読します|お読みします|ナレーションを(始め|開始し)ます)[。！!]?/g, '');
  s = s.replace(/^\s*(ナレーション|ナレーター|語り|読み上げ(文|用)?|本文|Narration|Narrator)\s*[:：]\s*/gim, '');
  // ト書き（括弧内の演出指示）
  s = s.replace(/[（(\[［〔][^）)\]］〕]{0,30}(声|調子|トーン|口調|間|笑|ため息|BGM|SE|効果音|ゆっくり|明るく|静かに|元気に|優しく|落ち着いて|ささやく|間を置|ポーズ|拍手|音楽)[^）)\]］〕]{0,30}[）)\]］〕]/g, '');
  s = s.replace(/[＊*]{1,2}[^＊*\n]{0,30}(声|調|間|笑|BGM|効果音)[^＊*\n]{0,30}[＊*]{1,2}/g, '');
  // Markdown 記号
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*[-*+・]\s+/gm, '');
  s = s.replace(/^\s*\d+[.)]\s+/gm, '');
  s = s.replace(/\|/g, '、');
  s = s.replace(/^[\s:\-、]+$/gm, '');
  s = s.replace(/(\*\*|__|\*|_|~~|==)/g, '');
  // 絵文字・装飾記号
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
  s = s.replace(/[※★☆■□◆◇●○◎▶▷►→←↑↓⇒⇔♪♫#＃＜＞<>{}\[\]［］〔〕"“”]/g, ' ');
  // 空白整理
  s = s.replace(/[ \t\u3000]+/g, ' ');
  s = s.replace(/\n{2,}/g, '\n');
  s = s.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => /[。！？!?」』）)]$/.test(l) ? l : l + '。').join('\n');
  return s.trim();
}

/* =========================================================
 * ナレッジカード
 * ========================================================= */

function actionAsk_(user, req) {
  if (!canSearch_(user)) throw appError_('書庫の検索は管理者のみ利用できる設定になっています。', 'FORBIDDEN');
  const q = String(req.question || '').trim();
  if (!q) throw appError_('質問を入力してください。', 'VALIDATION');
  if (q.length > 1000) throw appError_('質問は1000文字以内にしてください。', 'VALIDATION');
  const cache = CacheService.getScriptCache();
  if (cache.get('ask:' + user.userId)) throw appError_('前の質問を処理中です。少しお待ちください。', 'RATE');
  cache.put('ask:' + user.userId, '1', 10);

  const analysis = analyzeQuery_(q);
  const found = searchNotes_(q, analysis);
  if (!found.notes.length) {
    throw appError_('関連するノートが見つかりませんでした。言葉を変えて質問してみてください。（検索語: ' + analysis.keywords.join('、') + '）', 'NOT_FOUND');
  }
  const context = buildContext_(found.notes, found.terms);
  const result = generateAnswer_(q, context);

  // 出典ノートの対応付け
  const names = (result.sources || []).map(String);
  let sources = found.notes.filter(n => names.some(s => s === n.title || s.indexOf(n.title) >= 0 || n.title.indexOf(s) >= 0));
  if (!sources.length) sources = found.notes.slice(0, 3);
  const sourceList = sources.map(n => ({ title: n.title, path: n.path, fileId: n.fileId }));

  const places = (result.places || []).filter(p =>
    p && p.name && isFinite(p.lat) && isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0)
  ).slice(0, 8).map(p => ({ name: String(p.name), lat: Number(p.lat), lng: Number(p.lng), description: String(p.description || '') }));

  const narration = cleanNarration_(result.narration || result.answer).slice(0, 3000);
  const now = nowIso_();
  const card = {
    cardId: 'c_' + Utilities.getUuid().replace(/-/g, ''),
    ownerId: user.userId,
    title: String(result.title || q).slice(0, 80),
    question: q,
    answer: String(result.answer).slice(0, 40000),
    narration: narration,
    sources: JSON.stringify(sourceList),
    places: JSON.stringify(places),
    isShared: 'FALSE',      // 作成直後は必ず非公開
    sharedWith: '[]',
    createdAt: now, updatedAt: now
  };
  withLock_(() => appendObj_('Cards', card));
  log_(user.userId, 'ask', '[' + (result._model || '') + '] ' + q.slice(0, 200));
  return { ok: true, card: cardToClient_(card, user, buildUserMap_()), keywords: analysis.keywords, model: result._model || '' };
}

function buildUserMap_() {
  const map = {};
  readRows_('Users').forEach(u => { map[u.userId] = u; });
  return map;
}

function cardToClient_(c, viewer, userMap) {
  const isOwner = c.ownerId === viewer.userId;
  const owner = userMap[c.ownerId];
  const shared = parseJson_(c.sharedWith, []);
  const out = {
    cardId: c.cardId, title: c.title, question: c.question, answer: c.answer, narration: c.narration,
    sources: parseJson_(c.sources, []), places: parseJson_(c.places, []),
    isOwner: isOwner, ownerNickname: owner ? owner.nickname : '(退会済み)',
    createdAt: c.createdAt, updatedAt: c.updatedAt
  };
  if (isOwner) {
    out.isShared = toBool_(c.isShared);
    out.sharedWith = shared;
    out.sharedWithNames = shared.map(id => userMap[id] ? userMap[id].nickname : '(不明)');
  }
  return out;
}

function cardSummary_(c, viewer, userMap) {
  const full = cardToClient_(c, viewer, userMap);
  delete full.answer;
  delete full.narration;
  full.preview = cleanNarration_(c.answer).replace(/\n/g, ' ').slice(0, 100);
  full.placeCount = full.places.length;
  delete full.places;
  return full;
}

function canView_(c, user) {
  if (c.ownerId === user.userId) return true;
  return toBool_(c.isShared) && parseJson_(c.sharedWith, []).indexOf(user.userId) >= 0;
}

function actionListMyCards_(user) {
  const userMap = buildUserMap_();
  const cards = readRows_('Cards').filter(c => c.ownerId === user.userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(c => cardSummary_(c, user, userMap));
  return { ok: true, cards: cards };
}

function actionListSharedCards_(user) {
  const userMap = buildUserMap_();
  const cards = readRows_('Cards').filter(c => c.ownerId !== user.userId && canView_(c, user))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(c => cardSummary_(c, user, userMap));
  return { ok: true, cards: cards };
}

function findCard_(cardId) {
  return readRows_('Cards').find(c => c.cardId === String(cardId || ''));
}

function actionGetCard_(user, req) {
  const c = findCard_(req.cardId);
  if (!c) throw appError_('回答が見つかりません（削除された可能性があります）。', 'NOT_FOUND');
  if (!canView_(c, user)) throw appError_('この回答を閲覧する権限がありません。作成者に公開を依頼してください。', 'FORBIDDEN');
  return { ok: true, card: cardToClient_(c, user, buildUserMap_()) };
}

function actionUpdateSharing_(user, req) {
  return withLock_(() => {
    const c = findCard_(req.cardId);
    if (!c) throw appError_('回答が見つかりません。', 'NOT_FOUND');
    if (c.ownerId !== user.userId) throw appError_('公開設定を変更できるのは作成者だけです。', 'FORBIDDEN');
    const userMap = buildUserMap_();
    if (req.sharedWith !== undefined) {
      const ids = (Array.isArray(req.sharedWith) ? req.sharedWith : [])
        .map(String)
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .filter(id => id !== user.userId && userMap[id] && userMap[id].status !== 'disabled');
      c.sharedWith = JSON.stringify(ids);
    }
    if (req.isShared !== undefined) c.isShared = req.isShared === true ? 'TRUE' : 'FALSE';
    c.updatedAt = nowIso_();
    updateObj_('Cards', c);
    log_(user.userId, 'updateSharing', c.cardId + ' shared=' + c.isShared + ' to=' + c.sharedWith);
    return { ok: true, card: cardSummary_(c, user, userMap) };
  });
}

function actionDeleteCard_(user, req) {
  return withLock_(() => {
    const c = findCard_(req.cardId);
    if (!c) throw appError_('回答が見つかりません。', 'NOT_FOUND');
    if (c.ownerId !== user.userId) throw appError_('削除できるのは作成者だけです。', 'FORBIDDEN');
    getSheet_('Cards').deleteRow(c._row);
    log_(user.userId, 'deleteCard', c.cardId);
    return { ok: true };
  });
}

function actionListMembers_(user) {
  const members = readRows_('Users')
    .filter(u => u.userId !== user.userId && u.status !== 'disabled')
    .map(u => ({ userId: u.userId, nickname: u.nickname, emailMasked: maskEmail_(u.email) }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ja'));
  return { ok: true, members: members };
}

/* =========================================================
 * Gemini TTS
 * ========================================================= */

function actionTts_(user, req) {
  const text = cleanNarration_(String(req.text || '')).slice(0, 1800);
  if (!text) throw appError_('読み上げる文章がありません。', 'VALIDATION');
  const voice = String(req.voice || prop_('GEMINI_TTS_VOICE'));
  const resp = geminiGenerate_('tts', {
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  });
  const cand = resp.candidates && resp.candidates[0];
  const part = cand && cand.content && cand.content.parts && cand.content.parts.find(p => p.inlineData);
  if (!part) throw appError_('音声を生成できませんでした。', 'GEMINI');
  const mime = part.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000';
  const rateMatch = mime.match(/rate=(\d+)/);
  return {
    ok: true,
    audio: part.inlineData.data,          // base64 (16bit PCM, little endian, mono)
    mimeType: mime,
    sampleRate: rateMatch ? Number(rateMatch[1]) : 24000,
    model: resp._model || ''
  };
}

/* =========================================================
 * 索引ステータス（管理者）
 * ========================================================= */

function actionIndexStatus_(user) {
  const last = parseJson_(prop_('INDEX_LAST_RUN', ''), null);
  const sh = getSheet_('NoteIndex');
  return {
    ok: true,
    isAdmin: isAdmin_(user),
    noteCount: Math.max(0, sh.getLastRow() - 1),
    lastRun: last,
    model: prop_('GEMINI_MODEL'),
    modelFallback: prop_('GEMINI_MODEL_FALLBACK'),
    thinkingLevel: prop_('GEMINI_THINKING_LEVEL'),
    ttsModel: prop_('GEMINI_TTS_MODEL'),
    ttsModelFallback: prop_('GEMINI_TTS_MODEL_FALLBACK'),
    keyCount: getApiKeys_().length,
    version: APP_VERSION
  };
}

function actionReindex_(user, req) {
  if (!isAdmin_(user)) throw appError_('索引の更新は管理者のみ実行できます。', 'FORBIDDEN');
  const res = buildIndex_(req.full === true);
  log_(user.userId, 'reindex', JSON.stringify(res.summary || res));
  return res;
}

/* =========================================================
 * セットアップ・テスト用（GASエディタから手動実行）
 * ========================================================= */

/** 初回に1回実行：スプレッドシート/シート作成、既定プロパティ、定期索引トリガー */
function setup() {
  let ssId = prop_('SPREADSHEET_ID', '');
  let ss;
  if (!ssId) {
    ss = SpreadsheetApp.create('Obsidian書庫AI_データ');
    PROPS.setProperty('SPREADSHEET_ID', ss.getId());
    console.log('スプレッドシートを新規作成しました: ' + ss.getUrl());
  } else {
    ss = SpreadsheetApp.openById(ssId);
  }

  Object.keys(SHEET_DEFS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SHEET_DEFS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eef7');
    sh.setFrozenRows(1);
    // 全セルを書式なしテキストに（数式インジェクション防止・型の一貫性）
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  });
  ['シート1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });

  Object.keys(DEFAULT_PROPS).forEach(k => {
    if (!PROPS.getProperty(k)) PROPS.setProperty(k, DEFAULT_PROPS[k]);
  });
  if (!PROPS.getProperty('PASSWORD_PEPPER')) PROPS.setProperty('PASSWORD_PEPPER', randomToken_());

  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'buildIndex');
  if (!exists) ScriptApp.newTrigger('buildIndex').timeBased().everyHours(1).create();

  console.log('setup 完了。スプレッドシート: ' + ss.getUrl());
  console.log('次に VAULT_FOLDER_ID と GEMINI_API_KEY_1 を設定し、rebuildIndexFull() を実行してください。');
}

/** 第1モデル・予備モデルをそれぞれ個別にテスト */
function testGemini() {
  [prop_('GEMINI_MODEL'), prop_('GEMINI_MODEL_FALLBACK')].filter(Boolean).forEach(model => {
    try {
      const body = { contents: [{ role: 'user', parts: [{ text: '「接続テスト成功」とだけ返してください。' }] }], generationConfig: {} };
      if (supportsThinkingLevel_(model)) body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };
      console.log('✅ ' + model + ' : ' + extractText_(callGemini_(model, body)));
    } catch (e) {
      console.log('❌ ' + model + ' : ' + (e.userMessage || e.message));
    }
  });
  console.log('自動切替込みの実動作: ' + extractText_(geminiGenerate_('text', { contents: [{ role: 'user', parts: [{ text: 'OKとだけ返して' }] }] }, { thinkingLevel: 'low' })));
}

/** 読み上げモデルを個別にテスト */
function testTts() {
  [prop_('GEMINI_TTS_MODEL'), prop_('GEMINI_TTS_MODEL_FALLBACK')].filter(Boolean).forEach(model => {
    try {
      const resp = callGemini_(model, {
        contents: [{ role: 'user', parts: [{ text: 'こんにちは。読み上げのテストです。' }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: prop_('GEMINI_TTS_VOICE') } } } }
      });
      const part = resp.candidates[0].content.parts.find(p => p.inlineData);
      console.log('✅ ' + model + ' : ' + part.inlineData.mimeType + ' / base64長さ ' + part.inlineData.data.length);
    } catch (e) {
      console.log('❌ ' + model + ' : ' + (e.userMessage || e.message));
    }
  });
}

/** 既存環境のモデル設定を v1.1.0 の推奨値に更新（1回だけ実行） */
function upgradeModelSettings() {
  const rec = {
    GEMINI_MODEL: 'gemini-4-hydrogen',
    GEMINI_MODEL_FALLBACK: 'gemini-3.8-flash',
    GEMINI_THINKING_LEVEL: 'medium',
    GEMINI_TTS_MODEL: 'gemini-3.8-flash-tts',
    GEMINI_TTS_MODEL_FALLBACK: 'gemini-2.5-flash-preview-tts'
  };
  Object.keys(rec).forEach(k => {
    console.log(k + ': ' + (PROPS.getProperty(k) || '(なし)') + ' → ' + rec[k]);
    PROPS.setProperty(k, rec[k]);
  });
  console.log('更新しました。続けて testGemini と testTts を実行してください。');
}

function testMail() {
  const me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, '【' + prop_('APP_NAME') + '】メール送信テスト', 'メール送信のテストです。残り送信可能数: ' + MailApp.getRemainingDailyQuota());
  console.log('送信しました: ' + me);
}

function testCleanNarration() {
  const sample = 'はい、以下の文章を読み上げます。\n## 京都の旅\n（明るい声で）**清水寺**は[[京都旅行2024|京都旅行]]で訪れました😊【出典: 京都旅行2024】\n- 落ち着いたトーンで読み上げてください。';
  console.log(cleanNarration_(sample));
}
