/* Obsidian書庫AI — app.js  v1.1.0
 * フロントエンド（Vanilla JS）。GAS Web API と text/plain JSON で通信します。
 */
(() => {
  'use strict';

  /* =========================================================
   * 設定・共通ヘルパー
   * ========================================================= */
  const CFG = Object.assign({
    GAS_URL: '', APP_NAME: 'Obsidian書庫AI', APP_VERSION: 'v1.1.0',
    OBSIDIAN_VAULT_NAME: '', TTS_VOICES: [{ id: 'Kore', label: 'Kore' }]
  }, window.APP_CONFIG || {});

  const LS = {
    token: 'shoko_token', gasUrl: 'shoko_gas_url', font: 'shoko_font', voice: 'shoko_voice'
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* noop */ } }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 3500);
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = label || '処理中…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }

  /* =========================================================
   * GAS URL（config.js 優先 → localStorage フォールバック）
   * ========================================================= */
  function getGasUrl() {
    const fromConfig = String(CFG.GAS_URL || '').trim();
    return fromConfig || lsGet(LS.gasUrl).trim();
  }
  function isValidGasUrl(u) {
    return /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(u);
  }

  /* =========================================================
   * API 呼び出し
   * ========================================================= */
  const state = {
    token: lsGet(LS.token),
    user: null,
    myCards: [],
    sharedCards: [],
    members: null,
    shareTarget: null,
    currentTab: 'ask'
  };

  async function api(action, params = {}, opts = {}) {
    const url = opts.url || getGasUrl();
    if (!url) {
      openSettings();
      throw new Error('GASのURLが未設定です。「⚙ 設定」から入力してください。');
    }
    let res;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライト回避
        body: JSON.stringify(Object.assign({ action, token: state.token }, params)),
        redirect: 'follow'
      });
      res = await r.json();
    } catch (e) {
      throw new Error('サーバーに接続できませんでした。通信状況やGASのURL・公開設定を確認してください。');
    }
    if (!res.ok) {
      if (res.code === 'AUTH' && !opts.silentAuth) {
        clearSession();
        showView('auth');
      } else if (res.code === 'MUST_CHANGE') {
        showChangePw(true);
      }
      const err = new Error(res.error || 'エラーが発生しました。');
      err.code = res.code;
      throw err;
    }
    return res;
  }

  function clearSession() {
    state.token = '';
    state.user = null;
    state.members = null;
    state.myCards = [];
    lsSet(LS.token, '');
    updateHeader();
  }

  /* =========================================================
   * 画面切り替え
   * ========================================================= */
  function showView(name) {
    ['Loading', 'Auth', 'ChangePw', 'Main'].forEach(v => {
      $('#view' + v).classList.toggle('hidden', v.toLowerCase() !== name.toLowerCase());
    });
    if (name === 'auth') {
      $('#pendingCardNotice').classList.toggle('hidden', !sessionStorage.getItem('pendingCard'));
    }
    window.scrollTo(0, 0);
  }

  function updateHeader() {
    const logged = !!state.user;
    $('#userChip').classList.toggle('hidden', !logged);
    $('#btnLogout').classList.toggle('hidden', !logged);
    if (logged) $('#userChip').textContent = '👤 ' + state.user.nickname + ' さん';
  }

  function openModal(id) {
    $('#' + id).classList.remove('hidden');
    document.body.classList.add('modal-open');
  }
  function closeModal(id) {
    $('#' + id).classList.add('hidden');
    if (!$$('.modal').some(m => !m.classList.contains('hidden'))) document.body.classList.remove('modal-open');
    if (id === 'cardModal') TTS.stop();
  }

  /* =========================================================
   * パスワード表示/非表示トグル（全パスワード欄に自動付与）
   * ========================================================= */
  function attachPasswordToggles(root = document) {
    $$('input[type=password]', root).forEach(input => {
      if (input.parentElement.classList.contains('pw-wrap')) return;
      const wrap = document.createElement('span');
      wrap.className = 'pw-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-toggle';
      btn.setAttribute('aria-label', 'パスワードを表示');
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = '👁';
      btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.textContent = show ? '🙈' : '👁';
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      });
      wrap.appendChild(btn);
    });
  }

  /* =========================================================
   * 認証
   * ========================================================= */
  function switchAuthTab(tab) {
    $$('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.authTab === tab));
    $$('.auth-pane').forEach(p => p.classList.toggle('hidden', p.dataset.authPane !== tab));
  }

  function initAuth() {
    $$('[data-auth-tab]').forEach(el => el.addEventListener('click', e => {
      e.preventDefault();
      switchAuthTab(el.dataset.authTab);
    }));

    $('#agreeCheck').addEventListener('change', e => { $('#btnRegister').disabled = !e.target.checked; });

    $('#formLogin').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]');
      setBusy(btn, true, 'ログイン中…');
      try {
        const res = await api('login', { email: f.email.value.trim(), password: f.password.value });
        state.token = res.token;
        lsSet(LS.token, res.token);
        state.user = res.user;
        f.password.value = '';
        afterLogin();
      } catch (err) {
        toast(err.message, true);
      } finally { setBusy(btn, false); }
    });

    $('#formRegister').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, btn = $('#btnRegister');
      if (!f.agreed.checked) { toast('注意書き・免責事項への同意が必要です。', true); return; }
      setBusy(btn, true, '登録中…');
      try {
        const res = await api('register', { email: f.email.value.trim(), nickname: f.nickname.value.trim(), agreed: true });
        toast(res.message);
        $('#formLogin').email.value = f.email.value.trim();
        f.reset();
        switchAuthTab('login');
        $('#formLogin').password.focus();
      } catch (err) {
        toast(err.message, true);
      } finally {
        setBusy(btn, false);
        btn.disabled = !f.agreed.checked;
      }
    });

    $('#formForgot').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]');
      setBusy(btn, true, '送信中…');
      try {
        const res = await api('forgotPassword', { email: f.email.value.trim() });
        toast(res.message);
        $('#formLogin').email.value = f.email.value.trim();
        switchAuthTab('login');
      } catch (err) {
        toast(err.message, true);
      } finally { setBusy(btn, false); }
    });

    $('#formChangePw').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]');
      const np = f.newPassword.value, cp = f.confirmPassword.value;
      if (np !== cp) { toast('新しいパスワード（確認）が一致しません。', true); return; }
      if (np.length < 8 || !/[A-Za-z]/.test(np) || !/[0-9]/.test(np)) {
        toast('パスワードは8文字以上で、英字と数字を両方含めてください。', true); return;
      }
      setBusy(btn, true, '変更中…');
      try {
        const res = await api('changePassword', { currentPassword: f.currentPassword.value, newPassword: np });
        state.user = res.user;
        f.reset();
        toast(res.message);
        afterLogin();
      } catch (err) {
        toast(err.message, true);
      } finally { setBusy(btn, false); }
    });

    $('#btnCancelChangePw').addEventListener('click', () => { $('#formChangePw').reset(); showView('main'); });

    $('#btnLogout').addEventListener('click', async () => {
      TTS.stop();
      Voice.stop();
      try { await api('logout', {}, { silentAuth: true }); } catch (e) { /* noop */ }
      clearSession();
      $('#askResult').innerHTML = '';
      showView('auth');
      toast('ログアウトしました。');
    });
  }

  function showChangePw(forced) {
    $('#changePwNotice').classList.toggle('hidden', !forced);
    $('#btnCancelChangePw').classList.toggle('hidden', forced);
    showView('changepw');
  }

  function afterLogin() {
    state.members = null;
    updateHeader();
    if (state.user.mustChangePassword) { showChangePw(true); return; }
    showView('main');
    applyUserToUi();
    switchTab('ask');
    loadSharedCards(true);
    const pending = sessionStorage.getItem('pendingCard');
    if (pending) {
      sessionStorage.removeItem('pendingCard');
      openCard(pending);
    }
  }

  function applyUserToUi() {
    const u = state.user;
    const canSearch = u.canSearch !== false;
    $('#formAsk').classList.toggle('hidden', !canSearch);
    $('#askHint').classList.toggle('hidden', !canSearch);
    $('#askDisabled').classList.toggle('hidden', canSearch);
    $('#accountInfo').innerHTML =
      `<dt>ニックネーム</dt><dd>${escapeHtml(u.nickname)}</dd>` +
      `<dt>メール</dt><dd>${escapeHtml(u.email)}</dd>` +
      `<dt>権限</dt><dd>${u.isAdmin ? '管理者' : '会員'}</dd>`;
    $('#adminPanel').classList.toggle('hidden', !u.isAdmin);
  }

  /* =========================================================
   * メインタブ
   * ========================================================= */
  function switchTab(tab) {
    state.currentTab = tab;
    $$('.main-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
    if (tab === 'mine') loadMyCards();
    if (tab === 'shared') loadSharedCards();
    if (tab === 'account' && state.user && state.user.isAdmin) loadIndexStatus();
  }

  /* =========================================================
   * 音声入力（沈黙しても止まらない：continuous + 自動再接続）
   * ========================================================= */
  const Voice = {
    rec: null,
    active: false,
    committed: '',
    timer: null,
    // Android Chrome は continuous=true で結果が重複するため、continuous=false + 自動再接続で同じ挙動を実現
    isAndroid: /Android/i.test(navigator.userAgent),

    supported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); },

    start() {
      if (this.active) return;
      if (!this.supported()) {
        toast('このブラウザは音声入力に対応していません。Chrome（iPhoneはSafari）をお使いください。', true);
        return;
      }
      this.active = true;
      this.committed = $('#questionInput').value;
      this.open();
      this.ui(true);
    },

    open() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      rec.lang = 'ja-JP';
      rec.continuous = !this.isAndroid;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = e => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) this.committed += r[0].transcript;
          else interim += r[0].transcript;
        }
        const input = $('#questionInput');
        input.value = this.committed;
        input.scrollTop = input.scrollHeight;
        $('#interimText').textContent = interim;
      };
      rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          toast('マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください。', true);
          this.stop();
        } else if (e.error === 'audio-capture') {
          toast('マイクが見つかりません。接続を確認してください。', true);
          this.stop();
        }
        // no-speech / network / aborted は onend で自動再接続
      };
      rec.onend = () => {
        $('#interimText').textContent = '';
        if (!this.active) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          if (!this.active) return;
          try { this.open(); } catch (err) {
            this.timer = setTimeout(() => { if (this.active) { try { this.open(); } catch (e2) { this.stop(); } } }, 800);
          }
        }, 200);
      };
      this.rec = rec;
      rec.start();
    },

    stop() {
      if (!this.active && !this.rec) return;
      this.active = false;
      clearTimeout(this.timer);
      if (this.rec) { try { this.rec.stop(); } catch (e) { /* noop */ } }
      this.rec = null;
      this.ui(false);
    },

    ui(on) {
      const btn = $('#btnMic');
      btn.classList.toggle('listening', on);
      btn.setAttribute('aria-pressed', String(on));
      $('.mic-label', btn).textContent = on ? '⏹ 停止' : '🎤 音声で入力';
      $('#micStatus').classList.toggle('hidden', !on);
    }
  };

  /* =========================================================
   * 質問（検索・要約）
   * ========================================================= */
  function initAsk() {
    $('#btnMic').addEventListener('click', () => (Voice.active ? Voice.stop() : Voice.start()));
    $('#btnClearQ').addEventListener('click', () => {
      $('#questionInput').value = '';
      Voice.committed = '';
      $('#interimText').textContent = '';
    });
    $('#questionInput').addEventListener('input', e => { if (Voice.active) Voice.committed = e.target.value; });

    $('#formAsk').addEventListener('submit', async e => {
      e.preventDefault();
      if (Voice.active) {
        Voice.stop();
        await new Promise(r => setTimeout(r, 700)); // 最後の確定結果を待つ
      }
      const q = $('#questionInput').value.trim();
      if (!q) { toast('質問を入力してください。', true); return; }
      const btn = $('#btnAsk');
      setBusy(btn, true, '調べています…');
      TTS.stop();
      $('#askResult').innerHTML = '';
      $('#askProgress').classList.remove('hidden');
      const msgs = ['関連するノートを探しています…', 'ノートの内容を読み込んでいます…', 'AIが回答をまとめています…', 'もう少しお待ちください…'];
      let mi = 0;
      $('#askProgressText').textContent = msgs[0];
      const t = setInterval(() => { mi = Math.min(mi + 1, msgs.length - 1); $('#askProgressText').textContent = msgs[mi]; }, 7000);
      try {
        const res = await api('ask', { question: q });
        renderCardDetail($('#askResult'), res.card, { justCreated: true });
        $('#askResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        $('#askResult').innerHTML = `<div class="card notice notice-error">${escapeHtml(err.message)}</div>`;
      } finally {
        clearInterval(t);
        $('#askProgress').classList.add('hidden');
        setBusy(btn, false);
      }
    });
  }

  /* =========================================================
   * Markdown 簡易レンダラー（HTMLエスケープ後に変換）
   * ========================================================= */
  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/【出典[:：]\s*([^】]+)】/g, '<span class="src-tag">📄 $1</span>')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="wikilink">$2</span>')
      .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">$1</span>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  }

  function renderMarkdown(md) {
    const lines = escapeHtml(md || '').split(/\r?\n/);
    const out = [];
    let list = null, para = [], inCode = false, code = [], table = [];
    const flushPara = () => { if (para.length) { out.push('<p>' + inlineMd(para.join('<br>')) + '</p>'); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.type}>` + list.items.map(i => '<li>' + inlineMd(i) + '</li>').join('') + `</${list.type}>`); list = null; } };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter(r => !/^\|?\s*:?-{2,}/.test(r));
      out.push('<table>' + rows.map((r, i) => {
        const cells = r.replace(/^\||\|$/g, '').split('|').map(c => inlineMd(c.trim()));
        const tag = i === 0 ? 'th' : 'td';
        return '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      }).join('') + '</table>');
      table = [];
    };
    const flushAll = () => { flushPara(); flushList(); flushTable(); };

    lines.forEach(line => {
      if (/^```/.test(line)) {
        if (inCode) { out.push('<pre><code>' + code.join('\n') + '</code></pre>'); code = []; inCode = false; }
        else { flushAll(); inCode = true; }
        return;
      }
      if (inCode) { code.push(line); return; }
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); table.push(line.trim()); return; }
      flushTable();
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`); return; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); return; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); return; }
      if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push('<blockquote>' + inlineMd(m[1]) + '</blockquote>'); return; }
      if (!line.trim()) { flushPara(); flushList(); return; }
      if (list) flushList();
      para.push(line);
    });
    if (inCode) out.push('<pre><code>' + code.join('\n') + '</code></pre>');
    flushAll();
    return out.join('\n');
  }

  /* =========================================================
   * 読み上げ用テキストの前処理（GAS側 cleanNarration_ と同じ規則）
   * メタ発言・ト書き・記号類を除去し、純粋なナレーション本文のみ残す
   * ========================================================= */
  function cleanNarration(text) {
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
    s = s.replace(/^\s*(はい|了解です|了解しました|承知しました|かしこまりました|わかりました)[、。！!]?\s*/g, '');
    s = s.replace(/[^。！？!?\n]*(以下|次|こちら)の(文章|テキスト|内容|原稿|ナレーション)を[^。！？!?\n]*(読み上げ|お読み|朗読)[^。！？!?\n]*[。！!]?/g, '');
    s = s.replace(/[^。！？!?\n]*(読み上げて|朗読して|ナレーションして)(ください|下さい)[^。！？!?\n]*[。！!]?/g, '');
    s = s.replace(/[^。！？!?\n]*(読み上げます|朗読します|お読みします|ナレーションを(始め|開始し)ます)[。！!]?/g, '');
    s = s.replace(/^\s*(ナレーション|ナレーター|語り|読み上げ(文|用)?|本文|Narration|Narrator)\s*[:：]\s*/gim, '');
    s = s.replace(/[（(\[［〔][^）)\]］〕]{0,30}(声|調子|トーン|口調|間|笑|ため息|BGM|SE|効果音|ゆっくり|明るく|静かに|元気に|優しく|落ち着いて|ささやく|間を置|ポーズ|拍手|音楽)[^）)\]］〕]{0,30}[）)\]］〕]/g, '');
    s = s.replace(/[＊*]{1,2}[^＊*\n]{0,30}(声|調|間|笑|BGM|効果音)[^＊*\n]{0,30}[＊*]{1,2}/g, '');
    s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
    s = s.replace(/^\s*>\s?/gm, '');
    s = s.replace(/^\s*[-*+・]\s+/gm, '');
    s = s.replace(/^\s*\d+[.)]\s+/gm, '');
    s = s.replace(/\|/g, '、');
    s = s.replace(/^[\s:\-、]+$/gm, '');
    s = s.replace(/(\*\*|__|\*|_|~~|==)/g, '');
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
    s = s.replace(/[※★☆■□◆◇●○◎▶▷►→←↑↓⇒⇔♪♫#＃＜＞<>{}\[\]［］〔〕"“”]/g, ' ');
    s = s.replace(/[ \t\u3000]+/g, ' ');
    s = s.replace(/\n{2,}/g, '\n');
    s = s.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => (/[。！？!?」』）)]$/.test(l) ? l : l + '。')).join('\n');
    return s.trim();
  }

  function splitForTts(text, max = 450) {
    const sentences = text.split(/(?<=[。！？!?\n])/).map(s => s.trim()).filter(Boolean);
    const chunks = [];
    let cur = '';
    sentences.forEach(s => {
      while (s.length > max) { // 極端に長い文は分割
        if (cur) { chunks.push(cur); cur = ''; }
        chunks.push(s.slice(0, max));
        s = s.slice(max);
      }
      if ((cur + s).length > max && cur) { chunks.push(cur); cur = ''; }
      cur += s;
    });
    if (cur) chunks.push(cur);
    return chunks;
  }

  /* =========================================================
   * Gemini TTS プレーヤー（PCM → WAV に変換して順番に再生）
   * ========================================================= */
  function pcmBase64ToWavUrl(b64, sampleRate) {
    const bin = atob(b64);
    const len = bin.length;
    const buf = new ArrayBuffer(44 + len);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + len, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, len, true);
    const bytes = new Uint8Array(buf, 44);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  const TTS = {
    audio: new Audio(),
    chunks: [], cache: {}, urls: [], idx: 0,
    session: 0, playing: false, paused: false, ui: null, voice: '',

    load(text, ui) {
      this.stop();
      this.chunks = splitForTts(cleanNarration(text));
      this.ui = ui;
      this.idx = 0;
    },

    fetchChunk(i) {
      if (!this.cache[i]) {
        const voice = this.voice;
        this.cache[i] = api('tts', { text: this.chunks[i], voice }).then(r => {
          const url = pcmBase64ToWavUrl(r.audio, r.sampleRate || 24000);
          this.urls.push(url);
          return url;
        });
        this.cache[i].catch(() => { delete this.cache[i]; });
      }
      return this.cache[i];
    },

    async play(voice) {
      if (!this.chunks.length) { toast('読み上げる文章がありません。', true); return; }
      if (this.paused && voice === this.voice) {
        this.paused = false; this.playing = true;
        this.audio.play().catch(() => {});
        this.render('再生中');
        return;
      }
      if (voice !== this.voice) { this.cache = {}; this.revoke(); }
      this.voice = voice;
      // iOS対策：ユーザー操作の直後に無音を再生して再生許可を得る
      this.audio.src = SILENT_WAV;
      this.audio.play().catch(() => {});
      this.session++;
      this.playing = true; this.paused = false;
      this.playIndex(this.paused ? this.idx : 0, this.session);
    },

    async playIndex(i, session) {
      if (session !== this.session) return;
      if (i >= this.chunks.length) { this.playing = false; this.idx = 0; this.render('読み上げが終わりました', 1); return; }
      this.idx = i;
      this.render(`音声を準備中…（${i + 1}/${this.chunks.length}）`, i / this.chunks.length);
      let url;
      try { url = await this.fetchChunk(i); } catch (err) {
        if (session === this.session) { this.playing = false; this.render('読み上げに失敗しました'); toast(err.message, true); }
        return;
      }
      if (session !== this.session) return;
      if (i + 1 < this.chunks.length) this.fetchChunk(i + 1).catch(() => {}); // 先読み
      this.audio.onended = () => this.playIndex(i + 1, session);
      this.audio.src = url;
      try {
        await this.audio.play();
        this.render(`再生中（${i + 1}/${this.chunks.length}）`, (i + 0.5) / this.chunks.length);
      } catch (e) {
        this.playing = false;
        this.render('「▶ 読み上げ」をもう一度押してください');
      }
    },

    pause() {
      if (!this.playing) return;
      this.audio.pause();
      this.playing = false; this.paused = true;
      this.render('一時停止中');
    },

    stop() {
      this.session++;
      try { this.audio.pause(); } catch (e) { /* noop */ }
      this.audio.onended = null;
      this.playing = false; this.paused = false; this.idx = 0;
      this.render('', 0);
    },

    revoke() { this.urls.forEach(u => URL.revokeObjectURL(u)); this.urls = []; },

    render(msg, ratio) {
      if (!this.ui || !document.body.contains(this.ui)) return;
      const st = $('.tts-status', this.ui);
      if (st) st.textContent = msg || '';
      if (ratio !== undefined) {
        const bar = $('.tts-progress > span', this.ui);
        if (bar) bar.style.width = Math.round(ratio * 100) + '%';
      }
    }
  };

  /* =========================================================
   * 共有（LINE / URLコピー）
   * ========================================================= */
  function shareUrl(cardId) {
    return location.origin + location.pathname + '?card=' + encodeURIComponent(cardId);
  }

  function shareLine(card) {
    if (card.isOwner !== false && card.isShared === false) {
      if (!confirm('この回答はまだ「非公開」です。\n相手は開いても見られません。このままLINEを開きますか？\n（先に公開先を選んで「公開」にするのがおすすめです）')) return;
    }
    const text = `【${CFG.APP_NAME}】${card.title}\n${shareUrl(card.cardId)}`;
    window.open('https://line.me/R/msg/text/?' + encodeURIComponent(text), '_blank', 'noopener');
  }

  async function copyUrl(card) {
    const url = shareUrl(card.cardId);
    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* noop */ }
      ta.remove();
    }
    toast('URLをコピーしました' + (card.isShared === false ? '（※まだ非公開です）' : ''));
  }

  /* =========================================================
   * Google Earth / Earth Studio 連携データ
   * ========================================================= */
  function offsetLatLng(lat, lng, bearingDeg, distM) {
    const R = 6371000, d = distM / R, th = bearingDeg * Math.PI / 180;
    const p1 = lat * Math.PI / 180, l1 = lng * Math.PI / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * 180 / Math.PI, lng: ((l2 * 180 / Math.PI) + 540) % 360 - 180 };
  }

  function cameraFor(p, heading, tilt, range) {
    const t = tilt * Math.PI / 180;
    const pos = offsetLatLng(p.lat, p.lng, (heading + 180) % 360, range * Math.sin(t));
    return {
      longitude: +pos.lng.toFixed(6), latitude: +pos.lat.toFixed(6),
      altitudeMeters: Math.round(range * Math.cos(t)), heading: heading, tilt: tilt,
      targetLongitude: p.lng, targetLatitude: p.lat, rangeMeters: range
    };
  }

  function secToTc(sec) {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function buildEarthStudioJson(card) {
    const SEG = 10;
    const keyframes = [];
    card.places.forEach((p, i) => {
      const t0 = i * SEG;
      [
        { dt: 0, h: 0, tilt: 0, range: 30000, note: '上空から接近' },
        { dt: 5, h: 0, tilt: 45, range: 2500, note: 'ズームイン' },
        { dt: SEG - 0.5, h: 90, tilt: 60, range: 1200, note: '旋回して見下ろす' }
      ].forEach(k => {
        keyframes.push(Object.assign({
          time: secToTc(t0 + k.dt), seconds: t0 + k.dt, place: p.name, motion: k.note
        }, cameraFor(p, k.h, k.tilt, k.range)));
      });
    });
    return {
      format: 'obsidian-shoko-ai/earth-studio-camera@1',
      title: card.title,
      createdAt: new Date().toISOString(),
      howToUse: [
        'Google Earth Studio（https://earth.google.com/studio/）で「Blank Project」を作成し、長さを settings.durationSeconds 秒にします。',
        '各 keyframes の seconds の位置で、Camera Position に longitude / latitude / altitudeMeters、Camera Rotation に heading（Pan）/ tilt を入力してキーフレームを打ちます。',
        'Camera Target を使う場合は targetLongitude / targetLatitude を注視点に設定してください。',
        'tilt は 0=真下、90=水平。座標はAIの知識による概算のため、必要に応じて微調整してください。',
        '同梱の KML を Google Earth（Web/Pro）で開くと、同じ順番のツアーをプレビューできます。'
      ],
      settings: { fps: 30, resolution: '1920x1080', durationSeconds: card.places.length * SEG },
      places: card.places,
      keyframes: keyframes
    };
  }

  function xmlEsc(s) { return escapeHtml(s); }

  function buildKml(card) {
    const placemarks = card.places.map(p => `
    <Placemark>
      <name>${xmlEsc(p.name)}</name>
      <description>${xmlEsc(p.description || '')}</description>
      <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>
    </Placemark>`).join('');
    const flys = card.places.map(p => `
        <gx:FlyTo><gx:duration>5</gx:duration><gx:flyToMode>smooth</gx:flyToMode>
          <LookAt><longitude>${p.lng}</longitude><latitude>${p.lat}</latitude><altitude>0</altitude>
            <heading>0</heading><tilt>45</tilt><range>2500</range><altitudeMode>relativeToGround</altitudeMode></LookAt>
        </gx:FlyTo>
        <gx:FlyTo><gx:duration>4</gx:duration><gx:flyToMode>smooth</gx:flyToMode>
          <LookAt><longitude>${p.lng}</longitude><latitude>${p.lat}</latitude><altitude>0</altitude>
            <heading>90</heading><tilt>60</tilt><range>1200</range><altitudeMode>relativeToGround</altitudeMode></LookAt>
        </gx:FlyTo>
        <gx:Wait><gx:duration>1</gx:duration></gx:Wait>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${xmlEsc(card.title)}</name>${placemarks}
    <gx:Tour>
      <name>${xmlEsc(card.title)} フライト</name>
      <gx:Playlist>${flys}
      </gx:Playlist>
    </gx:Tour>
  </Document>
</kml>`;
  }

  function download(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function safeFileName(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'card'; }

  function earthWebUrl(p) {
    return `https://earth.google.com/web/@${p.lat},${p.lng},0a,1500d,35y,0h,60t,0r`;
  }
  function mapsUrl(p) {
    return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  }

  /* =========================================================
   * 回答カード詳細の描画
   * ========================================================= */
  function statusPill(card) {
    if (!card.isOwner) return `<span class="status-pill status-from">💌 ${escapeHtml(card.ownerNickname)} さんから</span>`;
    return card.isShared
      ? '<span class="status-pill status-shared">🔓 公開中</span>'
      : '<span class="status-pill status-private">🔒 非公開（自分のみ）</span>';
  }

  function renderCardDetail(container, card, opts = {}) {
    const voices = CFG.TTS_VOICES || [];
    const savedVoice = lsGet(LS.voice) || (voices[0] && voices[0].id) || 'Kore';
    const sources = card.sources || [];
    const places = card.places || [];
    const vault = String(CFG.OBSIDIAN_VAULT_NAME || '').trim();

    const sourceHtml = sources.length ? sources.map(s => {
      const link = (vault && card.isOwner)
        ? ` <a href="obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(s.path)}">Obsidianで開く</a>` : '';
      return `<li>📄 <strong>${escapeHtml(s.title)}</strong>${link}<span class="source-path">${escapeHtml(s.path || '')}</span></li>`;
    }).join('') : '<li>（出典情報なし）</li>';

    const placesHtml = places.length ? `
      <div class="sub-block">
        <p class="sub-title">🌏 地図・Google Earth（${places.length}か所）</p>
        <div class="place-list">
          ${places.map(p => `
            <div class="place-item">
              <span class="place-name">📍 ${escapeHtml(p.name)}</span>
              <span class="place-links">
                <a class="btn btn-ghost btn-sm" href="${earthWebUrl(p)}" target="_blank" rel="noopener">Google Earthで見る</a>
                <a class="btn btn-ghost btn-sm" href="${mapsUrl(p)}" target="_blank" rel="noopener">地図</a>
              </span>
              ${p.description ? `<span class="place-desc">${escapeHtml(p.description)}</span>` : ''}
            </div>`).join('')}
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary btn-sm" data-act="es-json">⬇ Earth Studio用カメラJSON</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="es-kml">⬇ KML（Google Earthツアー）</button>
        </div>
        <p class="hint">座標はAIによる概算です。JSONの使い方はファイル内の「howToUse」に書いてあります。</p>
      </div>` : '';

    const ownerHtml = card.isOwner ? `
      <div class="sub-block">
        <p class="sub-title">🔐 公開設定と共有</p>
        <p class="share-targets" data-role="targets"></p>
        <div class="share-bar">
          <button type="button" class="btn btn-secondary btn-sm" data-act="members">👥 公開先・公開設定</button>
          <button type="button" class="btn btn-line btn-sm" data-act="line">LINEで送る</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="copy">🔗 URLをコピー</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="delete">🗑 削除</button>
        </div>
      </div>` : '';

    container.innerHTML = `
      <article class="card answer-card" data-card-id="${escapeHtml(card.cardId)}">
        <div class="answer-meta"><span data-role="pill">${statusPill(card)}</span> ・ ${fmtDate(card.createdAt)}</div>
        <h2 class="answer-title" id="cardModalTitle">${escapeHtml(card.title)}</h2>
        ${opts.justCreated ? '<p class="notice notice-info">この回答は <strong>非公開（自分のみ）</strong> で保存されました。家族・友人に見せるときは下の「公開先・公開設定」から。</p>' : ''}
        <div class="answer-question">❓ ${escapeHtml(card.question)}</div>

        <div class="tts-block">
          <div class="tts-bar">
            <select data-role="voice" aria-label="声の種類">
              ${voices.map(v => `<option value="${escapeHtml(v.id)}" ${v.id === savedVoice ? 'selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-secondary btn-sm" data-act="tts-play">🔊 読み上げ</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="tts-pause">⏸ 一時停止</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="tts-stop">⏹ 停止</button>
          </div>
          <div class="tts-progress" style="margin-top:.5rem"><span></span></div>
          <p class="tts-status"></p>
        </div>

        <div class="md">${renderMarkdown(card.answer)}</div>

        <div class="sub-block">
          <p class="sub-title">📚 出典ノート</p>
          <ul class="source-list">${sourceHtml}</ul>
        </div>
        ${placesHtml}
        ${ownerHtml}
      </article>`;

    const root = $('article', container);
    root._card = card;
    updateTargetsText(root, card);

    const ttsBlock = $('.tts-block', root);
    root.addEventListener('click', async e => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const a = act.dataset.act;
      if (a === 'tts-play') {
        const voice = $('[data-role=voice]', root).value;
        lsSet(LS.voice, voice);
        if (TTS.ui !== ttsBlock) TTS.load(card.narration || card.answer, ttsBlock);
        TTS.play(voice);
      } else if (a === 'tts-pause') {
        if (TTS.ui === ttsBlock) TTS.pause();
      } else if (a === 'tts-stop') {
        if (TTS.ui === ttsBlock) TTS.stop();
      } else if (a === 'es-json') {
        download(`earth-studio_${safeFileName(card.title)}.json`, JSON.stringify(buildEarthStudioJson(card), null, 2), 'application/json');
      } else if (a === 'es-kml') {
        download(`earth-tour_${safeFileName(card.title)}.kml`, buildKml(card), 'application/vnd.google-earth.kml+xml');
      } else if (a === 'line') {
        shareLine(root._card);
      } else if (a === 'copy') {
        copyUrl(root._card);
      } else if (a === 'members') {
        openShareModal(root._card);
      } else if (a === 'delete') {
        deleteCard(root._card, () => {
          if (container.id === 'cardModalBody') closeModal('cardModal');
          container.innerHTML = '<div class="card empty">回答を削除しました。</div>';
        });
      }
    });
    $('[data-role=voice]', root).addEventListener('change', e => {
      lsSet(LS.voice, e.target.value);
      if (TTS.ui === ttsBlock) TTS.stop();
    });
  }

  function updateTargetsText(root, card) {
    const el = $('[data-role=targets]', root);
    if (el) {
      const names = card.sharedWithNames || [];
      el.innerHTML = '公開先：' + (names.length
        ? names.map(n => `<span class="chip">${escapeHtml(n)}</span>`).join('')
        : '（まだ選ばれていません）') + (card.isShared ? '' : ' <small>※現在は非公開</small>');
    }
    const pill = $('[data-role=pill]', root);
    if (pill) pill.innerHTML = statusPill(card);
  }

  async function openCard(cardId) {
    $('#cardModalBody').innerHTML = '<div class="center-box"><div class="spinner"></div><p>読み込み中…</p></div>';
    openModal('cardModal');
    try {
      const res = await api('getCard', { cardId });
      renderCardDetail($('#cardModalBody'), res.card);
      history.replaceState(null, '', location.pathname);
    } catch (err) {
      $('#cardModalBody').innerHTML = `<div class="notice notice-error">${escapeHtml(err.message)}</div>`;
      history.replaceState(null, '', location.pathname);
    }
  }

  /* =========================================================
   * マイナレッジ（管理一覧）
   * ========================================================= */
  async function loadMyCards() {
    const box = $('#mineList');
    box.innerHTML = '<div class="center-box"><div class="spinner"></div></div>';
    try {
      const res = await api('listMyCards');
      state.myCards = res.cards;
      renderMyCards();
    } catch (err) {
      box.innerHTML = `<div class="notice notice-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderMyCards() {
    const box = $('#mineList');
    if (!state.myCards.length) {
      box.innerHTML = '<div class="empty">まだ回答がありません。「質問する」から書庫に質問してみましょう。</div>';
      return;
    }
    box.innerHTML = state.myCards.map(c => `
      <div class="list-item" data-id="${escapeHtml(c.cardId)}">
        <div class="list-head">
          <button type="button" class="list-title" data-act="open">${escapeHtml(c.title)}</button>
          <label class="switch-label">
            <span data-role="swtext">${c.isShared ? '公開' : '非公開'}</span>
            <span class="switch"><input type="checkbox" data-act="toggle" ${c.isShared ? 'checked' : ''} aria-label="公開・非公開の切り替え"><span class="slider"></span></span>
          </label>
        </div>
        <div class="list-meta">${fmtDate(c.createdAt)} ・ ❓ ${escapeHtml(c.question.slice(0, 60))}${c.placeCount ? ' ・ 📍' + c.placeCount : ''}</div>
        <p class="list-preview">${escapeHtml(c.preview)}…</p>
        <div class="share-targets">公開先：${(c.sharedWithNames || []).length
          ? c.sharedWithNames.map(n => `<span class="chip">${escapeHtml(n)}</span>`).join('')
          : '（未選択）'}</div>
        <div class="list-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="open">開く</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="members">👥 公開先</button>
          <button type="button" class="btn btn-line btn-sm" data-act="line">LINEで送る</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="copy">🔗 URLをコピー</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="delete">🗑</button>
        </div>
      </div>`).join('');
  }

  function findMyCard(id) { return state.myCards.find(c => c.cardId === id); }

  function initMineList() {
    const box = $('#mineList');
    box.addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (!act || act.dataset.act === 'toggle') return;
      const id = e.target.closest('.list-item').dataset.id;
      const card = findMyCard(id);
      if (!card) return;
      const a = act.dataset.act;
      if (a === 'open') openCard(id);
      else if (a === 'members') openShareModal(card);
      else if (a === 'line') shareLine(card);
      else if (a === 'copy') copyUrl(card);
      else if (a === 'delete') deleteCard(card, () => { state.myCards = state.myCards.filter(c => c.cardId !== id); renderMyCards(); });
    });
    box.addEventListener('change', async e => {
      if (e.target.dataset.act !== 'toggle') return;
      const input = e.target;
      const item = input.closest('.list-item');
      const card = findMyCard(item.dataset.id);
      const want = input.checked;
      if (want && !(card.sharedWith || []).length) {
        input.checked = false;
        toast('先に公開先のメンバーを選んでください。');
        openShareModal(card, true);
        return;
      }
      input.disabled = true;
      try {
        const res = await api('updateSharing', { cardId: card.cardId, isShared: want });
        Object.assign(card, res.card);
        $('[data-role=swtext]', item).textContent = want ? '公開' : '非公開';
        toast(want ? '公開しました（選んだメンバーだけが見られます）' : '非公開にしました');
      } catch (err) {
        input.checked = !want;
        toast(err.message, true);
      } finally { input.disabled = false; }
    });
  }

  async function deleteCard(card, onDone) {
    if (!confirm(`「${card.title}」を削除します。元に戻せません。よろしいですか？`)) return;
    try {
      await api('deleteCard', { cardId: card.cardId });
      toast('削除しました');
      state.myCards = state.myCards.filter(c => c.cardId !== card.cardId);
      if (onDone) onDone();
    } catch (err) { toast(err.message, true); }
  }

  /* =========================================================
   * 公開先メンバー選択モーダル
   * ========================================================= */
  async function openShareModal(card, autoEnable) {
    state.shareTarget = card;
    $('#shareModalCardTitle').textContent = '「' + card.title + '」';
    $('#shareToggle').checked = !!card.isShared || !!autoEnable;
    $('#memberList').innerHTML = '<div class="center-box"><div class="spinner"></div></div>';
    openModal('shareModal');
    try {
      if (!state.members) state.members = (await api('listMembers')).members;
      const selected = new Set(card.sharedWith || []);
      $('#memberList').innerHTML = state.members.length
        ? state.members.map(m => `
          <label class="member-item">
            <input type="checkbox" value="${escapeHtml(m.userId)}" ${selected.has(m.userId) ? 'checked' : ''}>
            <span>${escapeHtml(m.nickname)}</span>
            <small>${escapeHtml(m.emailMasked)}</small>
          </label>`).join('')
        : '<div class="empty">ほかの会員がまだいません。家族・友人に会員登録してもらってください。</div>';
    } catch (err) {
      $('#memberList').innerHTML = `<div class="notice notice-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function initShareModal() {
    $('#btnSelectAll').addEventListener('click', () => $$('#memberList input').forEach(i => { i.checked = true; }));
    $('#btnSelectNone').addEventListener('click', () => $$('#memberList input').forEach(i => { i.checked = false; }));
    $('#btnSaveShare').addEventListener('click', async () => {
      const card = state.shareTarget;
      if (!card) return;
      const ids = $$('#memberList input:checked').map(i => i.value);
      let isShared = $('#shareToggle').checked;
      if (isShared && !ids.length) {
        toast('公開するには、公開先のメンバーを1人以上選んでください。', true);
        return;
      }
      const btn = $('#btnSaveShare');
      setBusy(btn, true, '保存中…');
      try {
        const res = await api('updateSharing', { cardId: card.cardId, isShared, sharedWith: ids });
        Object.assign(card, res.card);
        const mine = findMyCard(card.cardId);
        if (mine && mine !== card) Object.assign(mine, res.card);
        if (state.currentTab === 'mine') renderMyCards();
        $$('article.answer-card').forEach(a => {
          if (a.dataset.cardId === card.cardId) { Object.assign(a._card, res.card); updateTargetsText(a, a._card); }
        });
        closeModal('shareModal');
        toast(isShared ? `${ids.length}人に公開しました` : '非公開で保存しました');
      } catch (err) {
        toast(err.message, true);
      } finally { setBusy(btn, false); }
    });
  }

  /* =========================================================
   * 届いた回答
   * ========================================================= */
  async function loadSharedCards(countOnly) {
    const box = $('#sharedList');
    if (!countOnly) box.innerHTML = '<div class="center-box"><div class="spinner"></div></div>';
    try {
      const res = await api('listSharedCards');
      state.sharedCards = res.cards;
      const badge = $('#sharedCount');
      badge.textContent = res.cards.length;
      badge.classList.toggle('hidden', !res.cards.length);
      if (countOnly) return;
      box.innerHTML = res.cards.length ? res.cards.map(c => `
        <div class="list-item" data-id="${escapeHtml(c.cardId)}">
          <div class="list-head">
            <button type="button" class="list-title" data-act="open">${escapeHtml(c.title)}</button>
            <span class="status-pill status-from">💌 ${escapeHtml(c.ownerNickname)} さん</span>
          </div>
          <div class="list-meta">${fmtDate(c.updatedAt)} ・ ❓ ${escapeHtml(c.question.slice(0, 60))}</div>
          <p class="list-preview">${escapeHtml(c.preview)}…</p>
          <div class="list-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-act="open">開いて読む・聞く 🔊</button>
          </div>
        </div>`).join('')
        : '<div class="empty">まだ届いた回答はありません。</div>';
    } catch (err) {
      if (!countOnly) box.innerHTML = `<div class="notice notice-error">${escapeHtml(err.message)}</div>`;
    }
  }

  /* =========================================================
   * 管理者：索引
   * ========================================================= */
  async function loadIndexStatus() {
    const dl = $('#indexStatus');
    dl.innerHTML = '<dt>状態</dt><dd>読み込み中…</dd>';
    try {
      const s = await api('indexStatus');
      const lr = s.lastRun;
      dl.innerHTML =
        `<dt>索引済みノート</dt><dd>${s.noteCount} 件</dd>` +
        `<dt>最終更新</dt><dd>${lr ? fmtDate(lr.at) + `（読込 ${lr.read} / 変更なし ${lr.kept}${lr.pending ? ' / 次回へ持越し ' + lr.pending : ''}・${lr.seconds}秒）` : '未実行'}</dd>` +
        `<dt>回答モデル</dt><dd>${escapeHtml(s.model)}${s.modelFallback ? '（予備: ' + escapeHtml(s.modelFallback) + '）' : ''}</dd>` +
        `<dt>思考レベル</dt><dd>${escapeHtml(s.thinkingLevel || '-')}</dd>` +
        `<dt>読み上げモデル</dt><dd>${escapeHtml(s.ttsModel)}${s.ttsModelFallback ? '（予備: ' + escapeHtml(s.ttsModelFallback) + '）' : ''}</dd>` +
        `<dt>APIキー</dt><dd>${s.keyCount} 本設定（優先順に自動切替）</dd>` +
        `<dt>サーバー版</dt><dd>${escapeHtml(s.version)}</dd>`;
    } catch (err) {
      dl.innerHTML = `<dt>エラー</dt><dd>${escapeHtml(err.message)}</dd>`;
    }
  }

  async function reindex(full) {
    const btn = full ? $('#btnReindexFull') : $('#btnReindex');
    if (full && !confirm('全ノートを読み直します。ノート数によっては数分かかります。実行しますか？')) return;
    setBusy(btn, true, '更新中…（数分かかることがあります）');
    try {
      const res = await api('reindex', { full: !!full });
      if (res.ok === false) throw new Error(res.error);
      const s = res.summary;
      toast(`索引を更新しました（${s.total}件／読込${s.read}件）` + (s.pending ? `。残り${s.pending}件は次回に続きます` : ''));
      loadIndexStatus();
    } catch (err) { toast(err.message, true); } finally { setBusy(btn, false); }
  }

  /* =========================================================
   * 設定モーダル・ガイド・文字サイズ
   * ========================================================= */
  function openSettings() {
    const fromConfig = String(CFG.GAS_URL || '').trim();
    $('#gasUrlInput').value = fromConfig || lsGet(LS.gasUrl);
    $('#gasUrlInput').disabled = !!fromConfig;
    $('#btnSaveGas').disabled = !!fromConfig;
    $('#gasUrlSource').textContent = fromConfig
      ? '現在は config.js の値を使用中です（変更は config.js を編集してください）。'
      : (lsGet(LS.gasUrl) ? '現在はこのブラウザに保存したURLを使用中です。' : 'まだ設定されていません。');
    $('#fontSizeSelect').value = lsGet(LS.font) || 'normal';
    openModal('settingsModal');
  }

  function applyFont(size) {
    document.documentElement.classList.remove('font-large', 'font-xlarge');
    if (size === 'large') document.documentElement.classList.add('font-large');
    if (size === 'xlarge') document.documentElement.classList.add('font-xlarge');
  }

  function initSettings() {
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnGuide').addEventListener('click', () => openModal('guideModal'));
    $('#btnTestGas').addEventListener('click', async () => {
      const url = $('#gasUrlInput').value.trim();
      if (!isValidGasUrl(url)) { toast('URLの形式が正しくありません（https://script.google.com/… で始まるURL）', true); return; }
      const btn = $('#btnTestGas');
      setBusy(btn, true, 'テスト中…');
      try {
        const res = await api('ping', {}, { url });
        toast(`接続OK：${res.app} ${res.version}`);
      } catch (err) { toast(err.message, true); } finally { setBusy(btn, false); }
    });
    $('#btnSaveGas').addEventListener('click', () => {
      const url = $('#gasUrlInput').value.trim();
      if (url && !isValidGasUrl(url)) { toast('URLの形式が正しくありません。', true); return; }
      lsSet(LS.gasUrl, url);
      toast(url ? 'GASのURLを保存しました' : 'GASのURLを削除しました');
      closeModal('settingsModal');
      if (!state.user) boot();
    });
    $('#fontSizeSelect').addEventListener('change', e => {
      lsSet(LS.font, e.target.value);
      applyFont(e.target.value);
    });

    // モーダル共通：閉じる
    $$('.modal').forEach(m => {
      m.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(m.id); });
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const open = $$('.modal').filter(m => !m.classList.contains('hidden')).pop();
      if (open) closeModal(open.id);
    });
  }

  /* =========================================================
   * 起動
   * ========================================================= */
  async function boot() {
    const params = new URLSearchParams(location.search);
    const cardParam = params.get('card');
    if (cardParam) sessionStorage.setItem('pendingCard', cardParam);

    if (!getGasUrl()) {
      showView('auth');
      openSettings();
      return;
    }
    if (!state.token) { showView('auth'); return; }
    showView('loading');
    try {
      const res = await api('me', {}, { silentAuth: true });
      state.user = res.user;
      afterLogin();
    } catch (err) {
      if (err.code === 'AUTH') clearSession();
      else toast(err.message, true);
      showView('auth');
    }
  }

  function init() {
    document.title = CFG.APP_NAME;
    $('#brandName').textContent = CFG.APP_NAME;
    $('#footerName').textContent = CFG.APP_NAME;
    $('#versionHeader').textContent = CFG.APP_VERSION;
    $('#versionFooter').textContent = CFG.APP_VERSION;
    applyFont(lsGet(LS.font));

    attachPasswordToggles();
    initAuth();
    initAsk();
    initMineList();
    initShareModal();
    initSettings();

    $$('.main-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#btnReloadMine').addEventListener('click', loadMyCards);
    $('#btnReloadShared').addEventListener('click', () => loadSharedCards());
    $('#btnOpenChangePw').addEventListener('click', () => showChangePw(false));
    $('#btnReindex').addEventListener('click', () => reindex(false));
    $('#btnReindexFull').addEventListener('click', () => reindex(true));
    $('#sharedList').addEventListener('click', e => {
      const act = e.target.closest('[data-act=open]');
      if (act) openCard(e.target.closest('.list-item').dataset.id);
    });

    if (!Voice.supported()) {
      $('#btnMic').title = 'このブラウザは音声入力に対応していません';
    }
    boot();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
