// Murder Game — сервер только для пополнения звёздами (вход не нужен).
// Запуск:  BOT_TOKEN=ваш_токен ADMIN_ID=ваш_id node server.js   (Node 18+, без зависимостей)
// ADMIN_ID — ваш id в StaticGram: напишите боту /id, он ответит. Туда приходят заявки на вывод.
// Токен хранится ТОЛЬКО в переменной окружения — в bot.html его быть не должно.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('Укажите BOT_TOKEN'); process.exit(1); }
const BASE = (process.env.API_BASE || 'https://api.staticgram.top') + '/bot' + TOKEN;
const PORT = +process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');   // на хостинге с диском укажите путь на диске
const DEV = /^[a-f0-9]{32}$/;
const ADMIN_ID = +process.env.ADMIN_ID || 0;

let db = { pending: {}, processed: [], withdrawals: [], stats: {}, users: {} };   // users: @username -> id (кто нажимал Start)   // pending: id устройства -> сколько звёзд ждёт зачисления
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));

async function call(method, params) {
  const r = await fetch(`${BASE}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}) });
  const d = await r.json();
  if (!d.ok) throw new Error(method + ': ' + (d.description || 'error'));
  return d.result;
}

/* Каталог подарков (getAvailableGifts), кэш на 5 минут */
let giftCache = { t: 0, gifts: [] };
async function gifts() {
  if (Date.now() - giftCache.t > 300000) {
    const r = await call('getAvailableGifts');
    giftCache = { t: Date.now(), gifts: (r.gifts || []).map(g => ({ id: String(g.id), price: g.star_count })).sort((a, b) => a.price - b.price) };
  }
  return giftCache.gifts;
}

/* Зачисление: каждый платёж (по его id) обрабатывается один раз */
function credit(id, payload, amount) {
  if (!id || db.processed.includes(id)) return;
  const m = /^dep:([a-f0-9]{32}):/.exec(payload || '');
  db.processed.push(id);
  if (m && amount > 0) {
    db.pending[m[1]] = (db.pending[m[1]] || 0) + amount;
    (db.stats[m[1]] = db.stats[m[1]] || { dep: 0, wd: 0 }).dep += amount;
  }
  if (db.processed.length > 3000) db.processed = db.processed.slice(-2000);
  save();
}

/* Обновления бота: подтверждаем оплату (иначе платёж не пройдёт) */
let offset = 0;
async function handle(u) {
  const f = u.message && u.message.from;
  if (f && f.username && db.users[f.username.toLowerCase()] !== f.id) { db.users[f.username.toLowerCase()] = f.id; save(); }
  if (u.pre_checkout_query) {
    const ok = String(u.pre_checkout_query.invoice_payload || '').startsWith('dep:');
    await call('answerPreCheckoutQuery', { pre_checkout_query_id: u.pre_checkout_query.id, ok, ...(ok ? {} : { error_message: 'Неверный счёт' }) });
    return;
  }
  const sp = u.message && u.message.successful_payment;
  if (sp) return credit(sp.telegram_payment_charge_id, sp.invoice_payload, sp.total_amount);

  const m = u.message;
  if (!m || !m.from || !m.text) return;
  const say = text => call('sendMessage', { chat_id: m.chat.id, text });
  const [cmd, arg] = m.text.trim().split(/\s+/);
  if (cmd === '/id' || cmd === '/start') return say('Ваш ID: ' + m.from.id);
  if (!ADMIN_ID || m.from.id !== ADMIN_ID) return;
  if (cmd === '/list') {
    const open = db.withdrawals.filter(w => w.status === 'new');
    return say(open.length ? open.map(w => `#${w.id} @${w.username} — ${w.amount} ★`).join('\n') : 'Новых заявок нет');
  }
  const w = db.withdrawals.find(x => x.id === +arg && x.status === 'new');
  if ((cmd === '/paid' || cmd === '/reject') && !w) return say('Заявка не найдена или уже обработана');
  if (cmd === '/paid') {
    if (w.gift_id) {
      try { await call('sendGift', { user_id: w.tg_id, gift_id: w.gift_id }); }
      catch (e) { return say('Не удалось отправить подарок: ' + e.message); }
    }
    w.status = 'paid'; (db.stats[w.dev] = db.stats[w.dev] || { dep: 0, wd: 0 }).wd += w.amount; save();
    return say(w.gift_id ? `Заявка #${w.id}: подарок отправлен` : `Заявка #${w.id} отмечена выплаченной`);
  }
  if (cmd === '/reject') {
    w.status = 'rejected'; db.pending[w.dev] = (db.pending[w.dev] || 0) + w.amount; save();
    return say(`Заявка #${w.id} отклонена, ${w.amount} ★ вернутся игроку`);
  }
}
(async function pollUpdates() {
  for (;;) {
    try {
      const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'pre_checkout_query'] });
      for (const u of ups) { offset = u.update_id + 1; await handle(u); }
    } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
})();

/* getStarTransactions — проверка по журналу бота (подстраховка к getUpdates) */
let syncing = false;
async function syncStars() {
  if (syncing) return; syncing = true;
  try {
    const r = await call('getStarTransactions', { limit: 100 });
    for (const tx of (r.transactions || []).slice().reverse()) {
      const payload = (tx.source && tx.source.invoice_payload) || tx.invoice_payload;
      if (payload) credit(tx.id, payload, tx.amount);   // без payload пропускаем — это не наш платёж
    }
  } catch (e) { console.error(e.message); }
  syncing = false;
}
setInterval(syncStars, 15000); syncStars();

/* HTTP */
const send = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const readBody = req => new Promise(r => { let s = ''; req.on('data', d => { s += d; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');   // чтобы страница с другого хоста (Netlify) могла обращаться к серверу
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/bot.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'bot.html')));
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'Не найдено' });
    const b = await readBody(req);
    if (!DEV.test(String(b.dev))) return send(res, 400, { error: 'Неверный запрос' });

    if (url === '/api/claim') {                       // забрать зачисленные звёзды
      const a = db.pending[b.dev] || 0;
      if (a) { delete db.pending[b.dev]; save(); }
      return send(res, 200, { amount: a });
    }
    if (url === '/api/deposit') {                     // создать счёт на оплату звёздами
      const v = Math.floor(+b.amount);
      if (!(v >= 15 && v <= 50000)) return send(res, 400, { error: 'Сумма от 15 до 50 000 ★' });
      const link = await call('createInvoiceLink', {
        title: 'Пополнение ★', description: `Пополнение баланса на ${v} ★`,
        payload: `dep:${b.dev}:${crypto.randomBytes(4).toString('hex')}`, currency: 'XTR', prices: [{ label: '★', amount: v }]
      });
      return send(res, 200, { link });
    }
    if (url === '/api/gifts') {                       // каталог подарков для вывода
      try { return send(res, 200, { gifts: await gifts() }); }
      catch (e) { console.error(e.message); return send(res, 502, { error: 'Каталог подарков недоступен' }); }
    }
    if (url === '/api/withdraw') {                    // заявка на вывод (звёздами или подарком)
      if (!ADMIN_ID) return send(res, 503, { error: 'Вывод не настроен' });
      const un = String(b.username || '').replace(/^@/, ''), gid = String(b.gift_id || '');
      let v = Math.floor(+b.amount), tgId = 0;
      if (!/^[A-Za-z0-9_]{3,32}$/.test(un)) return send(res, 400, { error: 'Неверный @username' });
      if (gid) {
        const g = (await gifts().catch(() => [])).find(x => x.id === gid);
        if (!g) return send(res, 400, { error: 'Подарок недоступен' });
        v = g.price; tgId = db.users[un.toLowerCase()];
        if (!tgId) return send(res, 400, { error: 'Сначала нажмите Start у @MurdergameBot' });
      } else if (!(v >= 100 && v <= 100000)) return send(res, 400, { error: 'Сумма от 100 ★' });
      if (db.withdrawals.some(w => w.dev === b.dev && w.status === 'new')) return send(res, 400, { error: 'Предыдущая заявка ещё не обработана' });
      const w = { id: db.withdrawals.length + 1, dev: b.dev, username: un, amount: v, status: 'new', time: Date.now(), gift_id: gid || undefined, tg_id: tgId || undefined };
      db.withdrawals.push(w); save();
      const st = db.stats[b.dev] || { dep: 0, wd: 0 };
      call('sendMessage', { chat_id: ADMIN_ID, text: `Заявка на вывод #${w.id}\n@${un}\nСумма: ${v} ★${gid ? '\nПодарок: ' + gid + ' (уйдёт автоматически после /paid)' : ''}\nПополнял всего: ${st.dep} ★, выведено ранее: ${st.wd} ★\n\n/paid ${w.id} — ${gid ? 'отправить подарок' : 'выплачено'}\n/reject ${w.id} — отклонить` }).catch(e => console.error(e.message));
      return send(res, 200, { id: w.id, amount: v });
    }
    send(res, 404, { error: 'Не найдено' });
  } catch (e) { console.error(e.message); send(res, 500, { error: 'Ошибка сервера' }); }
}).listen(PORT, () => console.log('http://localhost:' + PORT));
