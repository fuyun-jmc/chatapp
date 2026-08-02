/* ============================================================
 *  轻聊 · 前端逻辑
 *  手机号注册登录 / 按手机号加好友 / 实时收发文字、图片、视频、文件
 * ============================================================ */
(function () {
  'use strict';

  var CFG = window.CHAT_CONFIG || {};
  var PHONE_RE = /^1[3-9]\d{9}$/;
  var AVATAR_COLORS = ['#4f7cf7', '#1d9e75', '#d85a30', '#7f77dd', '#d4537e', '#ba7517', '#378add'];

  var $ = function (id) { return document.getElementById(id); };

  /* 原生 <dialog> 弹窗开关（安全：重复打开/关闭不抛异常） */
  function showModal(id) { var m = $(id); if (m) { m.classList.add('open'); m.removeAttribute('hidden'); } }
  function hideModal(id) { var m = $(id); if (m) { m.classList.remove('open'); m.setAttribute('hidden', ''); } }

  /* ---------- 配置检查 ---------- */
  var configured = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('YOUR_') === -1 &&
                   CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf('YOUR_') === -1;
  if (!configured) {
    $('config-warning').hidden = false;
    return;
  }

  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  var BUCKET = CFG.BUCKET || 'chat-files';
  var LIMIT = CFG.HISTORY_LIMIT || 300;

  var state = {
    uid: null,
    profile: null,
    friends: [],        // { id, phone, nickname }
    incoming: [],       // 待我处理的好友申请
    groups: [],         // { id, name, ownerId, memberIds, memberCount, iAmOwner }
    profilesById: {},   // uid -> { nickname, avatar_path, phone }
    active: null,       // 当前会话：好友对象或群组对象（type==='group'）
    unread: {},         // { peerId: number }  未读消息计数（好友或群）
    convTs: {},          // { convId: number }  会话“浮顶”时间戳；收到新消息或查看后设为 Date.now()，用于排序让它停留前置
    recallTimer: null,  // 定时刷新“撤回/删除”按钮的定时器
    urlCache: {},       // file_path -> signed url
    channel: null,
    deviceToken: null,  // 本机设备会话 token（持久在 localStorage）
    heartbeat: null,    // 心跳定时器
    forceChangePwd: false, // 账号找回后强制改密码
    recPhone: '',
    recCode: '',
    lastActive: {},     // uid -> last_active ISO 时间（好友在线状态）
    onlineTimer: null,  // 在线状态轮询定时器
    presenceChannel: null, // 在线状态 Realtime 广播频道
    titlesMap: {},       // uid -> { titleId, titleName, frameColor, frameStyle }（展示称号，用于头像框）
    gmAdminUid: null     // 后端 gm_admin_uid() 返回的管理员 uid；未取到时回退到 GM_ADMIN_UID 常量
  };

  // 超过该时长未活跃即视为离线（与心跳 30s 间隔匹配，留足余量）
  var ONLINE_WINDOW_MS = 2 * 60 * 1000;

  /* ============================================================
   *  工具函数
   * ============================================================ */
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  function colorOf(seed) {
    var s = String(seed || ''), n = 0;
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[n % AVATAR_COLORS.length];
  }

  function initialOf(name) { return (name || '?').trim().charAt(0).toUpperCase(); }

  /* 显示名：有备注时“备注名（对方昵称）”，否则显示昵称 */
  function displayName(peer) {
    if (peer.remark && peer.remark !== peer.nickname) {
      return peer.remark + '（' + peer.nickname + '）';
    }
    return peer.remark || peer.nickname || '用户';
  }

  /* 统一渲染头像：有自定义头像图则显示图片，否则显示首字母色块 */
  function setAvatar(node, opts) {
    opts = opts || {};
    var name = opts.nickname || opts.phone || '?';
    var seed = opts.phone || name;
    node.textContent = '';
    node.style.background = colorOf(seed);
    var old = node.querySelector('img');
    if (old) old.remove();
    if (opts.avatarPath) {
      signedUrl(opts.avatarPath).then(function (url) {
        if (!url) { node.textContent = initialOf(name); return; }
        var im = new Image();
        im.className = 'avatar-img';
        im.alt = name;
        im.onload = function () {
          node.textContent = '';
          node.style.background = 'transparent';
          node.appendChild(im);
        };
        im.onerror = function () { node.textContent = initialOf(name); };
        im.src = url;
      });
    } else {
      node.textContent = initialOf(name);
    }
  }

  function maskPhone(p) {
    return p && p.length === 11 ? p.slice(0, 3) + '****' + p.slice(7) : (p || '');
  }

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function dayKey(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function dayLabel(iso) {
    var d = new Date(iso), now = new Date();
    var today = dayKey(now.toISOString());
    var yest = new Date(now.getTime() - 86400000);
    if (dayKey(iso) === today) return '今天';
    if (dayKey(iso) === dayKey(yest.toISOString())) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function emailFor(phone) {
    return phone + '@' + (CFG.EMAIL_DOMAIN || 'chatapp.local');
  }

  function friendlyError(err) {
    var m = (err && (err.message || err.error_description)) || '操作失败，请重试';
    if (/Invalid login credentials/i.test(m)) return '手机号或密码不正确';
    if (/User already registered|already been registered/i.test(m)) return '该手机号已注册，请直接登录';
    if (/Password should be at least/i.test(m)) return '密码至少需要 6 位';
    if (/Email address .* is invalid|Email address is invalid/i.test(m))
      return '注册被邮箱格式校验拦截：请把 config.js 里的 EMAIL_DOMAIN 改成 example.com 再试';
    if (/duplicate key|profiles_phone_key/i.test(m)) return '该手机号已被占用';
    if (/row-level security|violates row-level/i.test(m)) return '没有权限执行该操作（可能还不是好友）';
    if (/rate limit|too many/i.test(m)) return '操作太频繁，请稍后再试';
    if (/Failed to fetch|NetworkError/i.test(m)) return '网络连接失败，检查网络或 Supabase 地址是否正确';
    return m;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ============================================================
   *  登录设备管理（查看 / 注销设备）
   * ============================================================ */
  function detectDeviceName() {
    var ua = navigator.userAgent || '';
    var os = '未知系统';
    if (/iPhone/.test(ua)) os = 'iPhone';
    else if (/iPad/.test(ua)) os = 'iPad';
    else if (/Android/.test(ua)) os = 'Android 设备';
    else if (/Windows Phone/.test(ua)) os = 'Windows Phone';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
    else if (/Linux/.test(ua)) os = 'Linux';
    var br = '浏览器';
    if (/Edg\//.test(ua)) br = 'Edge';
    else if (/OPR\//.test(ua)) br = 'Opera';
    else if (/Chrome\//.test(ua)) br = 'Chrome';
    else if (/Firefox\//.test(ua)) br = 'Firefox';
    else if (/Safari\//.test(ua)) br = 'Safari';
    return os + ' · ' + br;
  }

  function getDeviceToken() {
    try {
      var k = 'chatapp_device_token';
      var t = localStorage.getItem(k);
      if (!t) {
        t = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
            : Date.now() + '-' + Math.random().toString(36).slice(2);
        localStorage.setItem(k, t);
      }
      return t;
    } catch (e) { return 'anon-' + Math.random().toString(36).slice(2); }
  }

  /* ============================================================
   *  记住上次登录的手机号（用于自动预填，降低重新登录成本）
   *  说明：Supabase 已开启 persistSession，会话未过期时打开网页会
   *  自动恢复 session 直接登录（见 getSession 逻辑）。此处仅在
   *  WebView 清缓存导致 session 丢失时，帮助用户省去重输手机号。
   *  出于安全考虑，不保存密码，密码仍需手动输入。
   * ============================================================ */
  var ACCOUNTS_KEY = 'chatapp.accounts';          // JSON 数组，最新在前，保存登录过的账号
  var LAST_PHONE_KEY = 'chatapp.lastLoginPhone';  // 标记上次登录的账号（用于高亮/默认选中）

  // 记住一个登录过的账号：去重并放到列表最前，最多保留 8 个
  function rememberAccount(phone) {
    phone = (phone || '').trim();
    if (!phone) return;
    var list = getAccounts().filter(function (p) { return p !== phone; });
    list.unshift(phone);
    if (list.length > 8) list = list.slice(0, 8);
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch (e) {}
    try { localStorage.setItem(LAST_PHONE_KEY, phone); } catch (e) {}
  }
  function getAccounts() {
    try {
      var raw = localStorage.getItem(ACCOUNTS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(function (p) { return typeof p === 'string' && p; }) : [];
    } catch (e) { return []; }
  }
  function removeAccount(phone) {
    var list = getAccounts().filter(function (p) { return p !== phone; });
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function getLastPhone() {
    try { return localStorage.getItem(LAST_PHONE_KEY) || ''; } catch (e) { return ''; }
  }

  // 被其他设备注销时，清掉本机「该账号」的登录痕迹：从账号列表移除、清除上次登录标记、
  // 清除本机设备令牌，使目标设备回到干净登录页且不再自动登录。仅作用于当前账号，不影响同机其他账号。
  function clearCurrentAccountLocal() {
    try {
      var phone = (state.profile && state.profile.phone) || getLastPhone();
      if (!phone) return;
      removeAccount(phone);
      if (getLastPhone() === phone) {
        try { localStorage.removeItem(LAST_PHONE_KEY); } catch (e) {}
      }
      try { localStorage.removeItem('chatapp_device_token'); } catch (e) {}
    } catch (e) {}
  }

  // 渲染登录页的「已登录账号」列表：点击账号自动填入手机号并聚焦密码框，
  // 密码需用户自行输入（出于安全不保存密码）。
  function renderAccountList() {
    var wrap = $('account-list');
    if (!wrap) return;
    var list = getAccounts();
    wrap.innerHTML = '';
    if (!list.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.appendChild(el('div', 'account-list-title', '选择账号'));
    var last = getLastPhone();
    list.forEach(function (phone) {
      var chip = el('button', 'account-chip' + (phone === last ? ' is-last' : ''), '');
      chip.type = 'button';
      chip.setAttribute('data-phone', phone);
      chip.appendChild(el('span', 'account-phone', phone));
      var del = el('span', 'account-del', '×');
      del.setAttribute('data-del', phone);
      del.title = '移除该账号';
      chip.appendChild(del);
      wrap.appendChild(chip);
    });
    var other = el('button', 'account-chip account-chip-other', '使用其他账号');
    other.type = 'button';
    other.setAttribute('data-other', '1');
    wrap.appendChild(other);
  }

  // 页面切回登录态时刷新账号列表，并默认填好“上次登录”的手机号
  function initLoginRemembered() {
    renderAccountList();
    var phone = getLastPhone() || getAccounts()[0] || '';
    if (phone) {
      $('login-phone').value = phone;
      try { $('login-password').focus(); } catch (e) {}
    }
  }

  // 登录页账号列表点击委托：删除账号 / 选中账号填入 / 使用其他账号
  function onAccountListClick(e) {
    function up(node, sel) {
      while (node && node.nodeType === 1) {
        if (node.matches && node.matches(sel)) return node;
        node = node.parentNode;
      }
      return null;
    }
    var del = up(e.target, '.account-del');
    if (del) {
      e.preventDefault();
      removeAccount(del.getAttribute('data-del'));
      renderAccountList();
      return;
    }
    var chip = up(e.target, '.account-chip');
    if (!chip) return;
    if (chip.getAttribute('data-other')) {
      $('login-phone').value = '';
      $('login-password').value = '';
      try { $('login-phone').focus(); } catch (e2) {}
      return;
    }
    var phone = chip.getAttribute('data-phone') || '';
    if (!phone) return;
    $('login-phone').value = phone;
    $('login-password').value = '';
    try { $('login-password').focus(); } catch (e2) {}
  }

  // 登录时记录本机设备；表不存在（未跑迁移）时静默失败，不影响登录
  function registerDeviceSession() {
    if (!state.uid) return;
    var token = getDeviceToken();
    state.deviceToken = token;
    sb.from('device_sessions').upsert({
      token: token,
      user_id: state.uid,
      device_name: detectDeviceName(),
      user_agent: navigator.userAgent || '',
      last_seen: new Date().toISOString()
    }, { onConflict: 'token' })
      .then(function (r) { if (r.error) console.warn('registerDeviceSession:', r.error.message); })
      .catch(function (e) { console.warn('registerDeviceSession failed:', e && e.message); });
    // 登录即标记在线
    touchLastActive();
  }

  // 每 15s 保活 + 检测本机行是否被注销（被踢则自动登出），并广播在线状态
  function startHeartbeat() {
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.heartbeat = setInterval(function () {
      if (!state.uid || !state.deviceToken) return;
      var token = state.deviceToken;
      // 保活自己的在线状态
      touchLastActive();
      broadcastPresence();
      sb.from('device_sessions').update({ last_seen: new Date().toISOString() })
        .eq('token', token)
        .then(function (r) {
          if (r.error && /does not exist|relation/.test(r.error.message || '')) return;
          return sb.from('device_sessions').select('token').eq('token', token).maybeSingle();
        })
        .then(function (r) {
          if (r && r.data === null) {
            // 心跳兜底：本机设备行已不存在 → 立即下线并清除登录信息
            forceLogoutByRemote('你的账号已在其他设备被注销');
          } else if (r && r.error) {
            console.warn('heartbeat check:', r.error.message);
          }
        })
        .catch(function () {});
    }, 15000);
  }

  // 上报自己的活跃时间（写入 profiles.last_active，仅自己的行受策略允许）
  function touchLastActive() {
    if (!state.uid) return;
    sb.from('profiles').update({ last_active: new Date().toISOString() })
      .eq('id', state.uid)
      .then(function (r) { if (r.error) console.warn('touchLastActive:', r.error.message); })
      .catch(function () {});
  }

  // 某 uid 当前是否在线（last_active 在窗口内）
  function isOnline(uid) {
    var t = state.lastActive[uid];
    if (!t) return false;
    var ms = Date.parse(t);
    if (isNaN(ms)) return false;
    return (Date.now() - ms) < ONLINE_WINDOW_MS;
  }

  // 在头像右下角追加在线状态点：在线绿点，离线灰点（始终显示）
  function addOnlineDot(av, uid) {
    if (!av) return;
    var old = av.querySelector('.online-dot');
    if (old) old.remove();
    var dot = el('span', 'online-dot');
    dot.classList.add(isOnline(uid) ? 'online' : 'offline');
    av.appendChild(dot);
  }

  // 拉取所有好友的在线状态：直接查 profiles（全员可读），失败则静默降级为全离线
  function refreshOnline() {
    var ids = state.friends.map(function (f) { return f.id; });
    if (!ids.length) return;
    sb.from('profiles').select('id, last_active').in('id', ids)
      .then(function (r) {
        if (r.error) return;
        var map = {};
        (r.data || []).forEach(function (p) { map[p.id] = p.last_active; });
        state.lastActive = map;
        renderConversations();
        if (state.active && state.active.type === 'friend') updatePeerOnline();
      })
      .catch(function () {});
  }

  // 当前打开的好友聊天里，刷新头部在线指示（绿点 + “在线”文字）
  function updatePeerOnline() {
    if (!state.active || state.active.type !== 'friend') return;
    var av = $('peer-avatar');
    if (av) addOnlineDot(av, state.active.id);
    var ph = $('peer-phone');
    if (ph) ph.textContent = state.active.phone + (isOnline(state.active.id) ? ' · 在线' : '');
  }

  // 批量获取好友/自己/当前会话对象的展示称号（头像框渲染用）
  function loadDisplayTitles() {
    var ids = [state.uid];
    state.friends.forEach(function (f) { ids.push(f.id); });
    if (state.active && state.active.type === 'friend') ids.push(state.active.id);
    if (!ids.length) return Promise.resolve();
    return sb.rpc('get_profiles_titles', { p_ids: ids })
      .then(function (r) {
        if (r.error) throw r.error;
        state.titlesMap = {};
        (r.data || []).forEach(function (t) {
          if (t.title_id) {
            state.titlesMap[t.user_id] = {
              titleId: t.title_id,
              titleName: t.title_name,
              frameColor: t.frame_color || '#ffd700',
              frameStyle: t.frame_style || 'ring'
            };
          }
        });
        // 重新渲染好友列表，让头像框生效
        if (typeof renderConversations === 'function') renderConversations();
      })
      .catch(function () { state.titlesMap = state.titlesMap || {}; });
  }

  // 给头像元素套上称号边框（环 / 发光 / 加粗环）
  function applyTitleFrame(av, uid) {
    if (!av) return;
    av.style.boxShadow = '';
    av.style.border = '';
    var t = state.titlesMap && state.titlesMap[uid];
    if (!t || !t.titleId) return;
    var c = t.frameColor || '#ffd700';
    if (t.frameStyle === 'solid')      av.style.boxShadow = '0 0 0 4px ' + c;
    else if (t.frameStyle === 'glow')  av.style.boxShadow = '0 0 10px 3px ' + c;
    else                               av.style.boxShadow = '0 0 0 3px ' + c; // ring
    av.title = (av.title ? av.title + ' · ' : '') + t.titleName;
  }

  // 在名字容器后追加一个称号小徽标
  function addTitleBadge(container, uid) {
    if (!container) return;
    var old = container.querySelector('.title-badge');
    if (old) old.remove();
    var t = state.titlesMap && state.titlesMap[uid];
    if (!t || !t.titleId) return;
    var b = el('span', 'title-badge', t.titleName);
    b.style.background = t.frameColor || '#ffd700';
    container.appendChild(b);
  }

  // 给侧边栏“我”的头像与名字加上展示称号
  function applySelfTitle() {
    var av = $('me-avatar');
    if (av) applyTitleFrame(av, state.uid);
    var nm = $('me-name');
    if (nm) addTitleBadge(nm, state.uid);
  }

  // 个人设置：列出当前用户已拥有的称号，并支持切换佩戴
  function loadMyTitles() {
    var box = $('my-titles-list');
    var empty = $('my-titles-empty');
    if (!box) return;
    box.innerHTML = '<div class="title-loading">加载中…</div>';
    if (empty) empty.hidden = true;
    sb.from('user_titles')
      .select('title_id, source, granted_at, titles(id,name,description,frame_color,frame_style)')
      .eq('user_id', state.uid)
      .order('granted_at', { ascending: false })
      .then(function (r) {
        if (r.error) { box.innerHTML = '<div class="title-loading">称号加载失败</div>'; return; }
        var rows = (r.data || [])
          .map(function (u) { return { t: u.titles, granted_at: u.granted_at, source: u.source }; })
          .filter(function (x) { return x.t; });
        var wornId = state.titlesMap && state.titlesMap[state.uid] && state.titlesMap[state.uid].titleId;
        box.innerHTML = '';
        if (!rows.length) {
          if (empty) empty.hidden = false;
          return;
        }
        rows.forEach(function (x) {
          var t = x.t;
          var worn = t.id === wornId;
          var card = el('div', 'title-card' + (worn ? ' worn' : ''));
          // 边框预览
          var prev = el('div', 'title-prev');
          prev.style.background = '#fff';
          prev.style.boxShadow = (t.frame_style === 'solid' ? '0 0 0 4px ' :
                                  t.frame_style === 'glow' ? '0 0 10px 3px ' : '0 0 0 3px ') + (t.frame_color || '#ffd700');
          card.appendChild(prev);
          var info = el('div', 'title-info');
          info.appendChild(el('div', 'title-name', t.name));
          if (t.description) info.appendChild(el('div', 'title-desc', t.description));
          // 获得时间与来源
          var meta = el('div', 'title-meta');
          meta.appendChild(el('span', 'title-time', '获得于 ' + fmtDateTime(x.granted_at)));
          meta.appendChild(el('span', 'title-src', x.source === 'auto' ? '自动获得' : '手动授予'));
          info.appendChild(meta);
          card.appendChild(info);
          var btn = el('button', 'btn-mini' + (worn ? ' btn-outline' : ''), worn ? '取消佩戴' : '佩戴');
          btn.type = 'button';
          btn.onclick = function () { wearTitle(worn ? null : t.id, t.name, t.frame_color, t.frame_style); };
          card.appendChild(btn);
          box.appendChild(card);
        });
      })
      .catch(function () { box.innerHTML = '<div class="title-loading">称号加载失败</div>'; });
  }

  // 佩戴 / 取消佩戴称号，成功后立即刷新头像框
  function wearTitle(titleId, name, color, style) {
    sb.rpc('set_my_title', { p_title_id: titleId })
      .then(function (r) {
        if (r.error) throw r.error;
        // 更新本地展示称号并立刻重绘头像框
        if (titleId) {
          state.titlesMap = state.titlesMap || {};
          state.titlesMap[state.uid] = { titleId: titleId, titleName: name, frameColor: color || '#ffd700', frameStyle: style || 'ring' };
          toast('已佩戴称号：' + name);
        } else {
          if (state.titlesMap) delete state.titlesMap[state.uid];
          toast('已取消佩戴称号');
        }
        applySelfTitle();
        if (typeof renderConversations === 'function') renderConversations();
        loadMyTitles();
      })
      .catch(function (e) {
        var msg = (e && e.message === 'NOT_OWNED') ? '你尚未拥有该称号' : friendlyError(e);
        toast('操作失败：' + msg);
      });
  }

  function loadDeviceSessions() {
    var box = $('device-list');
    if (!box) return;
    box.innerHTML = '<li class="list-section">加载中…</li>';
    sb.from('device_sessions').select('id,token,device_name,created_at,last_seen')
      .eq('user_id', state.uid).order('last_seen', { ascending: false })
      .then(function (r) {
        if (r.error) { box.innerHTML = '<li class="list-section">设备列表加载失败</li>'; return; }
        var rows = r.data || [];
        if (!rows.length) { box.innerHTML = '<li class="list-section">暂无设备记录</li>'; return; }
        box.innerHTML = '';
        rows.forEach(function (d) {
          var li = el('li', 'device-item');
          var isMe = d.token === state.deviceToken;
          var info = el('div', 'device-info');
          info.appendChild(el('div', 'device-name',
            (isMe ? '📱 ' : '') + d.device_name + (isMe ? '（本机）' : '')));
          info.appendChild(el('div', 'device-meta',
            '登录 ' + fmtDateTime(d.created_at) + ' · 活跃 ' + fmtDateTime(d.last_seen)));
          li.appendChild(info);
          if (!isMe) {
            var btn = el('button', 'del-btn', '注销');
            btn.type = 'button';
            btn.onclick = function () { kickDevice(d.token, li); };
            li.appendChild(btn);
          }
          box.appendChild(li);
        });
      })
      .catch(function () { box.innerHTML = '<li class="list-section">设备列表加载失败</li>'; });
  }

  // 注销单台设备：优先用 security definer RPC 绕开可能的 RLS 缺失；
  // 若该函数不存在（用户没跑迁移 SQL），退回「直删」——device_sessions 的
  // ds_delete 策略允许删除 user_id = 自己的行（含名下其他设备），通常可直接成功。
  function kickDevice(token, li) {
    sb.rpc('kick_device', { p_token: token })
      .then(function (r) {
        if (r.error) throw r.error;
        finishKick(token, li);
      })
      .catch(function () {
        sb.from('device_sessions').delete().eq('token', token)
          .then(function (d) {
            if (d.error) { toast(friendlyError(d.error)); return; }
            finishKick(token, li);
          })
          .catch(function (e) { toast(friendlyError(e)); });
      });
  }

  function finishKick(token, li) {
    toast('已注销该设备');
    // 实时广播：让目标设备秒级下线（心跳作为兜底）
    broadcastKick({ token: token });
    if (li) li.remove();
  }

  function logoutOtherDevices() {
    if (!state.deviceToken) return;
    sb.rpc('logout_other_devices', { p_keep_token: state.deviceToken })
      .then(function (r) {
        if (r.error) throw r.error;
        finishLogoutOthers();
      })
      .catch(function () {
        sb.from('device_sessions').delete().eq('user_id', state.uid).neq('token', state.deviceToken)
          .then(function (d) {
            if (d.error) { toast(friendlyError(d.error)); return; }
            finishLogoutOthers();
          })
          .catch(function (e) { toast(friendlyError(e)); });
      });
  }

  function finishLogoutOthers() {
    toast('已登出其他所有设备');
    // 实时广播：让其他设备秒级下线（心跳作为兜底）
    broadcastKick({ exceptToken: state.deviceToken });
    loadDeviceSessions();
  }

  // ------------------------------------------------------------
  // Realtime 即时踢人：订阅 kick-{uid} 广播频道，收到针对本机的注销
  // 信号立即下线，避免等 30s 心跳轮询。心跳仍作为最终兜底。
  // ------------------------------------------------------------
  function setupKickChannel() {
    if (!state.uid) return;
    try {
      if (state.kickChannel) { sb.removeChannel(state.kickChannel); state.kickChannel = null; }
      state.kickChannel = sb.channel('kick-' + state.uid, {
        config: { broadcast: { self: false } }
      })
      .on('broadcast', { event: 'kick' }, function (payload) {
        var p = payload && payload.payload;
        if (!p) return;
        // 单台注销：payload.token 命中本机设备令牌
        if (p.token && p.token === state.deviceToken) {
          forceLogoutByRemote('你的账号已在其他设备被注销');
          return;
        }
        // 登出其他所有设备：排除本机令牌之外的全部下线
        if (p.exceptToken !== undefined && p.exceptToken !== state.deviceToken) {
          forceLogoutByRemote('你的账号已在其他设备被注销');
        }
      })
      .subscribe();
    } catch (e) {
      // Realtime 不可用（如项目未开启广播）时静默降级，仍靠心跳兜底
      state.kickChannel = null;
    }
  }

  function broadcastKick(payload) {
    if (!state.kickChannel) return;
    try {
      state.kickChannel.send({ type: 'broadcast', event: 'kick', payload: payload });
    } catch (e) {}
  }

  // ---------- 在线状态实时广播（好友上线/心跳即点亮，正常退出即变灰） ----------
  function setupPresenceChannel() {
    if (!state.uid) return;
    try {
      if (state.presenceChannel) { sb.removeChannel(state.presenceChannel); state.presenceChannel = null; }
      state.presenceChannel = sb.channel('online-presence', {
        config: { broadcast: { self: false } }
      })
      .on('broadcast', { event: 'tick' }, function (payload) {
        var p = payload && payload.payload;
        if (!p || !p.uid || p.uid === state.uid) return;
        // 只处理好友的在线变化
        var isFriend = state.friends.some(function (f) { return f.id === p.uid; });
        if (!isFriend) return;
        if (p.offline) {
          delete state.lastActive[p.uid];
        } else {
          state.lastActive[p.uid] = p.ts ? new Date(p.ts).toISOString() : new Date().toISOString();
        }
        renderConversations();
        if (state.active && state.active.type === 'friend' && state.active.id === p.uid) updatePeerOnline();
      })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') broadcastPresence(); // 上线即广播一次，让好友秒级看到我
      });
    } catch (e) {
      // Realtime 不可用时静默降级，仍靠轮询兜底
      state.presenceChannel = null;
    }
  }

  function broadcastPresence() {
    if (!state.presenceChannel || !state.uid) return;
    try {
      state.presenceChannel.send({ type: 'broadcast', event: 'tick', payload: { uid: state.uid, ts: Date.now() } });
    } catch (e) {}
  }

  function broadcastOffline() {
    if (!state.presenceChannel || !state.uid) return;
    try {
      state.presenceChannel.send({ type: 'broadcast', event: 'tick', payload: { uid: state.uid, offline: true } });
    } catch (e) {}
  }

  // 被远端注销后的统一本地下线：清本机会话 + 清该账号登录痕迹，不影响其他设备
  function forceLogoutByRemote(reason) {
    if (state.kickChannel) { try { sb.removeChannel(state.kickChannel); } catch (e) {} state.kickChannel = null; }
    if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
    clearCurrentAccountLocal();
    toast(reason || '你的账号已在其他设备被注销');
    // 仅清本机会话，避免误伤其他设备
    sb.auth.signOut({ scope: 'local' })
      .then(function () { teardown(); initLoginRemembered(); })
      .catch(function () { teardown(); initLoginRemembered(); });
  }

  /* ============================================================
   *  登录 / 注册
   * ============================================================ */
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('is-active');
      this.classList.add('is-active');
      var isLogin = this.dataset.tab === 'login';
      $('login-form').hidden = !isLogin;
      $('register-form').hidden = isLogin;
      $('login-error').hidden = true;
      $('reg-error').hidden = true;
    });
  }

  function showErr(id, msg) {
    var e = $(id);
    e.textContent = msg;
    e.hidden = false;
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var phone = $('login-phone').value.trim();
    var pwd = $('login-password').value;
    $('login-error').hidden = true;

    if (!PHONE_RE.test(phone)) return showErr('login-error', '请输入正确的 11 位手机号');
    if (pwd.length < 6) return showErr('login-error', '密码至少 6 位');

    var btn = $('login-submit');
    btn.disabled = true; btn.textContent = '登录中…';
    sb.auth.signInWithPassword({ email: emailFor(phone), password: pwd })
      .then(function (r) {
        if (r.error) throw r.error;
        rememberAccount(phone); // 记住本次登录的账号，下次在列表中点选
      })
    .catch(function (e) { showErr('login-error', friendlyError(e)); })
    .then(function () { btn.disabled = false; btn.textContent = '登录'; });
  });

  // 登录页账号列表：点击委托（选中填号 / 删除账号 / 使用其他账号）
  $('account-list').addEventListener('click', onAccountListClick);

  /* ============================================================
   *  账号找回（社交关系找回）
   * ============================================================ */
  function openRecovery() {
    resetRecovery();
    showModal('recovery-modal');
    $('rec-phone').focus();
  }

  function resetRecovery() {
    state.recPhone = '';
    state.recCode = '';
    $('rec-phone').value = '';
    $('rec-code-input').value = '';
    $('rec-error').hidden = true;
    $('rec-step1').hidden = false;
    $('rec-step2').hidden = true;
  }

  function genRecoveryCode() {
    var phone = $('rec-phone').value.trim();
    $('rec-error').hidden = true;
    if (!PHONE_RE.test(phone)) return showErr('rec-error', '请输入正确的 11 位手机号');
    // 客户端生成随机 6 位验证码
    var code = String(Math.floor(100000 + Math.random() * 900000));
    var btn = $('rec-gen-btn');
    btn.disabled = true; btn.textContent = '生成中…';
    sb.rpc('create_recovery_code', { p_phone: phone, p_code: code })
      .then(function (r) {
        if (r.error) throw r.error;
        if (!r.data) throw new Error('NO_PHONE');
        state.recPhone = phone;
        state.recCode = code;
        $('rec-code-display').textContent = code;
        $('rec-step1').hidden = true;
        $('rec-step2').hidden = false;
      })
      .catch(function (e) {
        if ((e && e.message) === 'NO_PHONE') showErr('rec-error', '该手机号未注册');
        else showErr('rec-error', friendlyError(e));
      })
      .then(function () { btn.disabled = false; btn.textContent = '生成验证码'; });
  }

  function verifyRecovery() {
    var phone = state.recPhone;
    var code = $('rec-code-input').value.trim();
    $('rec-error').hidden = true;
    if (!code) return showErr('rec-error', '请输入好友发给你的验证码');
    var btn = $('rec-verify-btn');
    btn.disabled = true; btn.textContent = '验证中…';
    sb.rpc('recover_account', { p_phone: phone, p_code: code })
      .then(function (r) {
        if (r.error) throw r.error;
        var tmp = r.data;
        if (!tmp) throw new Error('RECOVERY_FAIL');
        // 标记强制改密码；登录成功后 onAuthStateChange→start 完成时会自动打开设置
        state.forceChangePwd = true;
        return sb.auth.signInWithPassword({ email: emailFor(phone), password: tmp });
      })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('recovery-modal');
        toast('验证成功，请立即修改密码');
      })
      .catch(function (e) {
        if ((e && e.message) === 'RECOVERY_FAIL') {
          showErr('rec-error', '验证未通过：需至少 2 位好友发送该验证码，且验证码未过期/未使用');
        } else {
          showErr('rec-error', friendlyError(e));
        }
        state.forceChangePwd = false;
      })
      .then(function () { btn.disabled = false; btn.textContent = '验证并登录'; });
  }

  $('recovery-btn').addEventListener('click', openRecovery);
  $('recovery-close').addEventListener('click', function () {
    if (state.forceChangePwd) { toast('请先完成账号找回并修改密码'); return; }
    hideModal('recovery-modal');
  });
  $('rec-gen-btn').addEventListener('click', genRecoveryCode);
  $('rec-verify-btn').addEventListener('click', verifyRecovery);
  $('rec-reset-btn').addEventListener('click', resetRecovery);
  $('recovery-modal').addEventListener('click', function (e) {
    if (e.target === this && !state.forceChangePwd) hideModal('recovery-modal');
  });

  $('register-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var phone = $('reg-phone').value.trim();
    var nick = $('reg-nickname').value.trim();
    var pwd = $('reg-password').value;
    $('reg-error').hidden = true;

    if (!PHONE_RE.test(phone)) return showErr('reg-error', '请输入正确的 11 位手机号');
    if (!nick) return showErr('reg-error', '请填写昵称');
    if (pwd.length < 6) return showErr('reg-error', '密码至少 6 位');

    var btn = $('reg-submit');
    btn.disabled = true; btn.textContent = '注册中…';
    sb.auth.signUp({
      email: emailFor(phone),
      password: pwd,
      options: { data: { phone: phone, nickname: nick } }
    })
      .then(function (r) {
        if (r.error) throw r.error;
        if (!r.data.session) {
          throw new Error('注册成功但未自动登录。请到 Supabase 后台 Authentication → Providers → Email，关闭 "Confirm email" 后重新注册。');
        }
        rememberAccount(phone); // 注册并登录成功后同样记住账号
      })
      .catch(function (e) { showErr('reg-error', friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '注册并登录'; });
  });

  $('logout-btn').addEventListener('click', function () {
    // 退出前清理本机设备记录
    if (state.deviceToken) {
      // Supabase query builder 是 thenable 而非完整 Promise，必须先 .then() 再 .catch()
      sb.from('device_sessions').delete().eq('token', state.deviceToken)
        .then(function () {})
        .catch(function () {});
    }
    // 无论 signOut 成功还是失败（特殊设备/弱网可能 reject），
    // 都兜底强制切回登录页，避免“点了登出没反应”
    sb.auth.signOut({ scope: 'local' })
      .then(function () { teardown(); })
      .catch(function () { teardown(); });
  });

  /* ============================================================
   *  会话启动 / 结束
   * ============================================================ */
  sb.auth.onAuthStateChange(function (event, session) {
    if (session && session.user) {
      if (state.uid !== session.user.id) {
        state.uid = session.user.id;
        start(session);
      } else if (state.channel) {
        sb.realtime.setAuth(session.access_token);
      }
    } else {
      teardown();
    }
  });

  sb.auth.getSession().then(function (r) {
    removeBootLoader();
    if (r.data && r.data.session) {
      state.uid = r.data.session.user.id;
      start(r.data.session);
    } else {
      $('auth-view').hidden = false;
      initLoginRemembered(); // 预填上次登录的手机号
    }
  });

  function removeBootLoader() {
    var b = $('boot');
    if (b) { b.parentNode.removeChild(b); }
  }

  function teardown() {
    if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
    if (state.onlineTimer) { clearInterval(state.onlineTimer); state.onlineTimer = null; }
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
    if (state.kickChannel) { try { sb.removeChannel(state.kickChannel); } catch (e) {} state.kickChannel = null; }
    if (state.presenceChannel) {
      try { broadcastOffline(); } catch (e) {}
      try { sb.removeChannel(state.presenceChannel); } catch (e) {}
      state.presenceChannel = null;
    }
    state.uid = null; state.profile = null; state.friends = [];
    state.incoming = []; state.active = null; state.unread = {}; state.urlCache = {};
    $('app-view').hidden = true;
    $('auth-view').hidden = false;
    document.querySelector('.app-view').classList.remove('show-chat');
    $('chat-room').hidden = true;
    $('chat-empty').hidden = false;
  }

  function start(session) {
    $('auth-view').hidden = true;
    $('app-view').hidden = false;
    sb.realtime.setAuth(session.access_token);

    registerDeviceSession();
    startHeartbeat();
    setupKickChannel();
    setupPresenceChannel();
    // 连续登录计数 + 自动授予「连续登录 N 天」称号（失败不影响主流程）
    sb.rpc('touch_login_streak').then(function () {}).catch(function () {});
    // 拉取“绝对管理员”uid，用于决定 GM 入口是否可见
    refreshGmAdmin();

    // 在线状态：登录后拉一次；Realtime 广播负责秒级点亮，10s 轮询作兜底校正
    refreshOnline();
    if (state.onlineTimer) clearInterval(state.onlineTimer);
    state.onlineTimer = setInterval(refreshOnline, 10000);

    loadProfile()
      .then(loadRelations)
      .then(loadGroups)
      .then(loadDisplayTitles)
      .then(applySelfTitle)
      .then(subscribeRealtime)
      .then(function () {
        // 账号找回后：资料加载完即强制打开设置改密码
        if (state.forceChangePwd) openSettings();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function loadProfile() {
    return sb.from('profiles').select('id,phone,nickname,avatar_path').eq('id', state.uid).maybeSingle()
      .then(function (r) {
        if (r.error) throw r.error;
        if (!r.data) {
          // 触发器未生效时的兜底：用注册时写入的元数据补建资料
          return sb.auth.getUser().then(function (u) {
            var m = (u.data && u.data.user && u.data.user.user_metadata) || {};
            return sb.from('profiles').insert({
              id: state.uid,
              phone: m.phone || '未知',
              nickname: m.nickname || '用户'
            }).select().single();
          }).then(function (r2) {
            if (r2.error) throw r2.error;
            return r2.data;
          });
        }
        return r.data;
      })
      .then(function (p) {
        state.profile = p;
        $('me-name').textContent = p.nickname;
        $('me-phone').textContent = p.phone;
        setAvatar($('me-avatar'), { nickname: p.nickname, phone: p.phone, avatarPath: p.avatar_path });
      });
  }

  /* ============================================================
   *  好友关系
   * ============================================================ */
  function loadRelations() {
    return sb.from('friendships')
      .select('id,status,requester_id,addressee_id,created_at,requester_remark,addressee_remark,' +
              'pinned_by_requester,pinned_by_addressee,' +
              'requester:profiles!friendships_requester_id_fkey(id,phone,nickname,avatar_path),' +
              'addressee:profiles!friendships_addressee_id_fkey(id,phone,nickname,avatar_path)')
      .or('requester_id.eq.' + state.uid + ',addressee_id.eq.' + state.uid)
      .order('created_at', { ascending: false })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        var friends = [], incoming = [];
        rows.forEach(function (row) {
          var iAmRequester = row.requester_id === state.uid;
          var other = iAmRequester ? row.addressee : row.requester;
          if (!other) return;
          if (row.status === 'accepted') {
            var myRemark = iAmRequester ? row.requester_remark : row.addressee_remark;
            var pinned = iAmRequester ? row.pinned_by_requester : row.pinned_by_addressee;
            friends.push({
              id: other.id,
              phone: other.phone,
              nickname: other.nickname,
              avatar: other.avatar_path,
              remark: myRemark,
              relId: row.id,
              iAmRequester: iAmRequester,
              pinned: !!pinned,
              type: 'friend'
            });
          } else if (row.status === 'pending' && !iAmRequester) {
            incoming.push({ rowId: row.id, user: other });
          }
        });
        // 置顶的好友排到最前；其余保持原有（创建时间倒序）顺序
        friends.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
        state.friends = friends;
        state.incoming = incoming;
        friends.forEach(function (f) {
          state.profilesById[f.id] = { nickname: f.nickname, avatar_path: f.avatar, phone: f.phone };
        });
        renderFriends();
        renderRequests();
        refreshOnline(); // 好友加载完后立即拉一次在线状态

        // 当前会话对象被删除好友时收起聊天窗
        if (state.active && !friends.some(function (f) { return f.id === state.active.id; })) {
          state.active = null;
          $('chat-room').hidden = true;
          $('chat-empty').hidden = false;
        }
      });
  }

  function renderRequests() {
    var sec = $('requests-section'), list = $('request-list');
    list.innerHTML = '';
    if (!state.incoming.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('requests-count').textContent = state.incoming.length;

    state.incoming.forEach(function (req) {
      var li = el('li');
      var av = el('div', 'avatar sm');
      setAvatar(av, { nickname: req.user.nickname, phone: req.user.phone, avatarPath: req.user.avatar_path });
      var info = el('div', 'info');
      info.appendChild(el('div', 'nm', req.user.nickname));
      info.appendChild(el('div', 'ph', maskPhone(req.user.phone)));
      var ok = el('button', 'mini-ok', '同意');
      var no = el('button', 'mini-no', '拒绝');
      ok.onclick = function () { respond(req.rowId, 'accepted'); };
      no.onclick = function () { respond(req.rowId, 'rejected'); };
      li.appendChild(av); li.appendChild(info); li.appendChild(ok); li.appendChild(no);
      list.appendChild(li);
    });
  }

  function respond(rowId, status) {
    sb.from('friendships').update({ status: status, updated_at: new Date().toISOString() })
      .eq('id', rowId)
      .then(function (r) {
        if (r.error) throw r.error;
        toast(status === 'accepted' ? '已添加为好友' : '已拒绝');
        return loadRelations();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function renderFriends() { renderConversations(); }

  // 统一会话列表：好友 + 群聊合并渲染到 #chat-list
  function renderConversations() {
    var list = $('chat-list');
    if (!list) return;
    list.innerHTML = '';

    var all = state.groups.concat(state.friends);
    var pinned = all.filter(function (x) { return x.pinned; });
    var normal = all.filter(function (x) { return !x.pinned; });
    sortByRecent(pinned);
    sortByRecent(normal);

    var emptyTip = $('chat-empty-tip');
    if (emptyTip) emptyTip.hidden = all.length > 0;

    if (pinned.length) {
      list.appendChild(el('li', 'list-section', '置顶'));
      pinned.forEach(function (x) { list.appendChild(makeConversationItem(x)); });
    }
    if (normal.length) {
      if (pinned.length) list.appendChild(el('li', 'list-section', '会话'));
      normal.forEach(function (x) { list.appendChild(makeConversationItem(x)); });
    }
  }

  function makeConversationItem(x) {
    return x.type === 'group' ? makeGroupItem(x) : makeFriendItem(x);
  }

  function makeGroupItem(g) {
    var li = el('li');
    if (state.active && state.active.id === g.id) li.classList.add('is-active');
    var av = el('div', 'avatar sm');
    av.textContent = g.name ? g.name.charAt(0) : '群';
    av.style.background = '#7f77dd';
    var info = el('div', 'info');
    info.appendChild(el('div', 'nm', g.name));
    info.appendChild(el('div', 'ph', g.memberCount + ' 位成员'));
    li.appendChild(av); li.appendChild(info);

    var pin = el('button', 'pin-btn', g.pinned ? '已置顶' : '置顶');
    pin.type = 'button';
    if (g.pinned) pin.classList.add('pinned');
    pin.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); toggleGroupPin(g); };
    li.appendChild(pin);

    var cnt = state.unread[g.id] || 0;
    if (cnt > 0) {
      var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
      li.appendChild(badge);
    }
    li.onclick = function () { var gg = groupById(g.id); if (gg) openChat(gg); };
    return li;
  }

  // 按“会话浮顶时间戳 convTs”降序排序：有 ts 的（收到过新消息 / 向对方发过消息）排到最前，
  // 且彼此按时间先后——越晚的会话越靠前；没有 ts 的历史会话保持原相对顺序。
  function sortByRecent(arr) {
    arr.forEach(function (x, i) { x.__order = i; });   // 记录原始位置，保证无 ts 时顺序稳定
    arr.sort(function (a, b) {
      var ta = state.convTs[a.id] || 0;
      var tb = state.convTs[b.id] || 0;
      if (tb !== ta) return tb - ta;                    // 有 ts 的按时间倒序前置
      return (a.__order || 0) - (b.__order || 0);       // 无 ts 保持原始顺序
    });
  }

  // 把好友按“置顶 / 非置顶”分组渲染进容器；每组内未读优先。clickFn 为点击回调
  function renderGroupedFriends(container, friends, clickFn) {
    var pinned = friends.filter(function (f) { return f.pinned; });
    var normal  = friends.filter(function (f) { return !f.pinned; });
    sortByRecent(pinned);
    sortByRecent(normal);

    if (pinned.length) {
      container.appendChild(el('div', 'list-section', '置顶'));
      pinned.forEach(function (f) { container.appendChild(makeFriendRow(f, clickFn)); });
    }
    if (normal.length) {
      container.appendChild(el('div', 'list-section', pinned.length ? '非置顶' : '好友'));
      normal.forEach(function (f) { container.appendChild(makeFriendRow(f, clickFn)); });
    }
  }

  // 搜索结果用的行（带置顶/备注按钮与未读徽标），点击触发 clickFn
  function makeFriendRow(f, clickFn) {
    var row = el('div', 'row clickable');
    var av = el('div', 'avatar sm');
    setAvatar(av, { nickname: f.remark || f.nickname, phone: f.phone, avatarPath: f.avatar });
    var info = el('div', 'info');
    var nm = el('div', 'nm', displayName(f));
    info.appendChild(nm);
    info.appendChild(el('div', 'ph', f.phone + (f.remark ? ' · ' + f.nickname : '')));
    row.appendChild(av); row.appendChild(info);
    addOnlineDot(av, f.id);
    applyTitleFrame(av, f.id);
    addTitleBadge(nm, f.id);

    var pin = el('button', 'pin-btn', f.pinned ? '已置顶' : '置顶');
    pin.type = 'button';
    if (f.pinned) pin.classList.add('pinned');
    pin.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); togglePin(f); };
    row.appendChild(pin);

    var cnt = parseInt(state.unread[f.id] || 0, 10) || 0;
    if (cnt > 0) {
      var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
      badge.setAttribute('aria-label', '未读消息 ' + cnt + ' 条');
      row.appendChild(badge);
    }
    row.onclick = function () { clickFn(f); };
    return row;
  }

  function makeFriendItem(f) {
    var li = el('li');
    if (state.active && state.active.id === f.id) li.classList.add('is-active');
    var av = el('div', 'avatar sm');
    setAvatar(av, { nickname: f.remark || f.nickname, phone: f.phone, avatarPath: f.avatar });
    var info = el('div', 'info');
    var nm = el('div', 'nm', displayName(f));
    info.appendChild(nm);
    info.appendChild(el('div', 'ph', f.phone + (f.remark ? ' · ' + f.nickname : '')));
    li.appendChild(av); li.appendChild(info);
    addOnlineDot(av, f.id);
    applyTitleFrame(av, f.id);
    addTitleBadge(nm, f.id);

    var pin = el('button', 'pin-btn', f.pinned ? '已置顶' : '置顶');
    pin.type = 'button';
    if (f.pinned) pin.classList.add('pinned');
    pin.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); togglePin(f); };
    li.appendChild(pin);

    var cnt = parseInt(state.unread[f.id] || 0, 10) || 0;
    if (cnt > 0) {
      var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
      badge.setAttribute('aria-label', '未读消息 ' + cnt + ' 条');
      li.appendChild(badge);
    }
    li.onclick = function () { openChat(f); };
    return li;
  }

  function togglePin(f) {
    var col = f.iAmRequester ? 'pinned_by_requester' : 'pinned_by_addressee';
    var next = !f.pinned;
    var upd = {}; upd[col] = next;
    sb.from('friendships').update(upd).eq('id', f.relId)
      .then(function (r) {
        if (r.error) throw r.error;
        f.pinned = next;
        if (state.active && state.active.id === f.id) state.active.pinned = next;
        renderFriends();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function makeResultRow(user) {
    var row = el('div', 'row');
    var av = el('div', 'avatar sm');
    var remark = user.remark || '';
    setAvatar(av, { nickname: remark || user.nickname, phone: user.phone, avatarPath: user.avatar_path });
    var info = el('div', 'info');
    info.appendChild(el('div', 'nm', displayName(user)));
    info.appendChild(el('div', 'ph', user.phone + (remark ? ' · ' + user.nickname : '')));
    row.appendChild(av); row.appendChild(info);
    return row;
  }

  function onUnifiedSearch() {
    var kw = $('search-box').value.trim();
    var panel = $('search-result');
    var list = $('chat-list');
    if (!kw) {
      panel.hidden = true; panel.innerHTML = '';
      list.hidden = false;
      $('chat-empty-tip').hidden = (state.friends.length + state.groups.length) > 0;
      return;
    }
    list.hidden = true;
    $('chat-empty-tip').hidden = true;
    panel.hidden = false; panel.innerHTML = '';

    var q = kw.toLowerCase();
    var local = state.friends.filter(function (f) {
      var hay = [f.phone, f.nickname, f.remark, (f.remark ? f.nickname : '')]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    renderGroupedFriends(panel, local, function (f) {
      $('search-box').value = '';
      onUnifiedSearch();
      openChat(f);
    });

    if (PHONE_RE.test(kw)) {
      sb.from('profiles').select('id,phone,nickname,avatar_path').eq('phone', kw).maybeSingle()
        .then(function (r) {
          if (r.error) { toast(friendlyError(r.error)); return; }
          if (!r.data) {
            if (local.length === 0) panel.appendChild(el('div', 'note', '没有找到该手机号的用户，可能还没注册。'));
            return;
          }
          if (state.friends.some(function (f) { return f.id === r.data.id; })) return;
          var row = makeResultRow(r.data);
          var add = el('button', 'btn-mini', '加为好友');
          add.style.padding = '6px 12px';
          add.onclick = function (ev) { ev.stopPropagation(); sendRequest(r.data, add); };
          row.appendChild(add);
          panel.appendChild(row);
        });
    } else if (local.length === 0) {
      panel.appendChild(el('div', 'note', '没有找到相关好友'));
    }
  }

  /* ---------- 编辑好友备注 ---------- */
  function editRemark(f) {
    var cur = f.remark || '';
    var input = window.prompt('给好友设置备注名（留空可清除）：', cur);
    if (input === null) return; // 取消
    var val = input.trim().slice(0, 20);
    var payload = { updated_at: new Date().toISOString() };
    if (f.iAmRequester) payload.requester_remark = val || null;
    else payload.addressee_remark = val || null;

    sb.from('friendships').update(payload).eq('id', f.relId)
      .then(function (r) {
        if (r.error) throw r.error;
        f.remark = val || null;
        renderFriends();
        if (state.active && state.active.id === f.id) {
          $('peer-name').textContent = displayName(f);
          $('peer-avatar').textContent = initialOf(f.remark || f.nickname);
        }
        toast(val ? '已设置备注：' + val : '已清除备注');
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  /* ---------- 删除好友 ---------- */
  var pendingDelFriend = null;

  function deleteFriend(f) {
    if (!f.relId) { toast('找不到好友关系记录'); return; }
    pendingDelFriend = f;
    $('del-friend-text').textContent =
      '确定删除好友「' + (f.remark || f.nickname) + '」吗？\n删除后将从双方好友列表中移除（聊天记录仍保留）。';
    showModal('del-friend-modal');
  }

  function closeDelFriend() {
    hideModal('del-friend-modal');
    pendingDelFriend = null;
  }

  function confirmDelFriend() {
    var f = pendingDelFriend;
    if (!f) return;
    hideModal('del-friend-modal');
    pendingDelFriend = null;
    sb.from('friendships').delete().eq('id', f.relId)
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已删除好友');
        return loadRelations();
      })
      .then(function () {
        // loadRelations 内部会在当前会话好友已不存在时收起聊天窗
        $('peer-del-btn').hidden = true;
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  $('del-friend-close').addEventListener('click', closeDelFriend);
  $('del-friend-cancel').addEventListener('click', closeDelFriend);
  $('del-friend-confirm').addEventListener('click', confirmDelFriend);

  /* ============================================================
   *  个人设置（头像 + 名称）
   * ============================================================ */
  var pendingAvatar = null;   // 待保存的新头像路径（null 表示未改动）

  function openSettings() {
    if (!state.profile) return;
    pendingAvatar = null;
    $('settings-name').value = state.profile.nickname || '';
    setAvatar($('settings-avatar'), {
      nickname: state.profile.nickname,
      phone: state.profile.phone,
      avatarPath: state.profile.avatar_path
    });
    resetPwdFields();
    loadDeviceSessions();
    loadMyTitles();
    // 账号找回后强制改密码：显示提示条，并禁用关闭
    $('force-pwd-banner').hidden = !state.forceChangePwd;
    // 强制改密码期间不允许注销账号 / 进入 GM 后台（先完成安全流程）
    var dab = $('delete-account-btn');
    if (dab) dab.hidden = !!state.forceChangePwd;
    var gob = $('gm-open-btn');
    if (gob) gob.hidden = !!state.forceChangePwd;
    showModal('settings-modal');
  }

  function closeSettings() {
    if (state.forceChangePwd) {
      toast('出于安全，请先修改密码后再关闭');
      return;
    }
    hideModal('settings-modal');
    pendingAvatar = null;
  }

  // 个人设置内「切换账号」：登出当前账号并返回登录页，保留已记住的账号列表，
  // 下次可在登录页点选；强制改密码期间禁用。
  function switchAccountFromSettings() {
    if (state.forceChangePwd) {
      toast('出于安全，请先修改密码后再切换账号');
      return;
    }
    if (state.deviceToken) {
      // Supabase query builder 是 thenable 而非完整 Promise，必须先 .then() 再 .catch()
      sb.from('device_sessions').delete().eq('token', state.deviceToken)
        .then(function () {})
        .catch(function () {});
    }
    pendingAvatar = null;
    hideModal('settings-modal');
    // 无论 signOut 成功与否都兜底回到登录页（与登出按钮一致），并刷新账号列表
    sb.auth.signOut({ scope: 'local' })
      .then(function () { teardown(); initLoginRemembered(); })
      .catch(function () { teardown(); initLoginRemembered(); });
  }

  function resetPwdFields() {
    $('settings-newpwd').value = '';
    $('settings-confirm-pwd').value = '';
    $('change-pwd-error').hidden = true;
  }

  /* ============================================================
   *  注销账号（多步确认：确认 → 输入手机号+密码验证 → 再次确认 → 注销）
   * ============================================================ */

  // 步骤1：打开「确认要注销吗」
  function openDeleteAccount() {
    showModal('del-account-modal');
  }

  // 步骤2：进入输入手机号 + 密码验证
  function deleteAccountToVerify() {
    hideModal('del-account-modal');
    var ph = $('del-account-phone');
    ph.value = (state.profile && state.profile.phone) || '';
    $('del-account-pwd').value = '';
    $('del-account-verify-error').hidden = true;
    showModal('del-account-verify');
    try { ph.focus(); } catch (e) {}
  }

  // 步骤2 → 校验手机号与密码，通过后进入步骤3「再次确认」
  function deleteAccountVerify() {
    var phone = $('del-account-phone').value.trim();
    var pwd = $('del-account-pwd').value;
    var err = $('del-account-verify-error');
    err.hidden = true;

    if (!PHONE_RE.test(phone)) { err.textContent = '请输入正确的 11 位手机号'; err.hidden = false; return; }
    if (pwd.length < 6) { err.textContent = '密码至少 6 位'; err.hidden = false; return; }
    if (state.profile && phone !== state.profile.phone) {
      err.textContent = '输入的手机号与当前登录账号不一致';
      err.hidden = false; return;
    }

    var btn = $('del-account-verify-btn');
    btn.disabled = true; btn.textContent = '验证中…';
    // 用手机号+密码重新登录以验证身份（验证失败即密码错误）
    sb.auth.signInWithPassword({ email: emailFor(phone), password: pwd })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('del-account-verify');
        $('del-account-final-phone').textContent = phone;
        showModal('del-account-final');
      })
      .catch(function (e) {
        err.textContent = friendlyError(e);
        err.hidden = false;
        btn.disabled = false; btn.textContent = '确认';
      });
  }

  // 步骤3：最终确认 → 调用 RPC 删除账号
  function deleteAccountCommit() {
    var btn = $('del-account-final-btn');
    btn.disabled = true; btn.textContent = '注销中…';
    sb.rpc('delete_my_account')
      .then(function (r) {
        if (r && r.error) throw r.error;
        hideModal('del-account-final');
        toast('账号已注销');
        // 清除本机该账号痕迹（移除记住的账号、登录标记、设备令牌）
        try { clearCurrentAccountLocal(); } catch (e) {}
        // 作废会话并回到登录页（RPC 已删除用户，signOut 兜底）
        sb.auth.signOut({ scope: 'local' })
          .then(function () { teardown(); initLoginRemembered(); })
          .catch(function () { teardown(); initLoginRemembered(); });
      })
      .catch(function (e) {
        var msg = (e && (e.message || e.error_description)) || '';
        if (/delete_my_account|could not find|function .* does not exist|schema .* does not exist/i.test(msg)) {
          toast('注销失败：请先在 Supabase 执行 20260802_delete_account.sql 迁移');
        } else {
          toast('注销失败：' + friendlyError(e));
        }
        btn.disabled = false; btn.textContent = '确认注销';
      });
  }

  /* ============================================================
   *  绝对管理员（GM）后台
   *  入口在个人设置底部（刻意隐蔽）；输入口令后进入页面内覆盖层，
   *  可搜索全站用户、查看其群聊/好友，并强制删除群聊/好友/账号。
   *  口令仅存于本次会话内存，不写入 localStorage；所有 GM 操作 RPC
   *  均在数据库端再次校验口令（gm_check），保证前端拿不到口令也能拦住。
   * ============================================================ */
  var gmPwd = '';        // 本次会话的管理员口令（仅内存）
  var gmCurrent = null;  // 当前正在查看的目标用户 { uid, name, phone }
  // 管理员账号 uid（须与数据库 gm_admin_uid() 一致）。仅用于控制 GM 入口的可见性，
  // 真正的权限仍由后端 gm_check 校验 auth.uid() === gm_admin_uid() 且口令正确，前端拿不到权限。
  var GM_ADMIN_UID = '66f0744b-007b-4d5f-a9bc-2c5e4462baf9';

  // 从后端取“绝对管理员”uid（权威来源，避免前端硬编码漂移）。
  // 取不到（如尚未执行 gm_panel SQL）时回退到上面的常量，保证本机管理员依旧可见入口。
  function refreshGmAdmin() {
    try {
      sb.rpc('gm_admin_uid')
        .then(function (r) {
          if (r && !r.error && r.data) state.gmAdminUid = r.data;
          else state.gmAdminUid = GM_ADMIN_UID;
        })
        .catch(function () { state.gmAdminUid = GM_ADMIN_UID; });
    } catch (e) {
      state.gmAdminUid = GM_ADMIN_UID;
    }
  }

  function isGmAdmin() {
    var a = state.gmAdminUid || GM_ADMIN_UID;
    return !!state.uid && state.uid === a;
  }


  function openGmEntry() {
    $('gm-pwd-input').value = '';
    $('gm-pwd-error').hidden = true;
    var btn = $('gm-pwd-confirm');
    if (btn) { btn.disabled = false; btn.textContent = '进入'; }
    showModal('gm-pwd-modal');
    try { $('gm-pwd-input').focus(); } catch (e) {}
  }

  function gmTryAuth() {
    var pwd = $('gm-pwd-input').value;
    var err = $('gm-pwd-error');
    var btn = $('gm-pwd-confirm');
    function resetBtn() { if (btn) { btn.disabled = false; btn.textContent = '进入'; } }
    err.hidden = true;
    if (!pwd) { err.textContent = '请输入口令'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = '验证中…';
    try {
      sb.rpc('gm_auth', { p_pwd: pwd })
        .then(function (r) {
          if (r.error) throw r.error;
          if (!r.data) throw new Error('GM_AUTH_FAIL');
          gmPwd = pwd;
          hideModal('gm-pwd-modal');
          closeSettings();
          openGmPanel();
        })
        .catch(function (e) {
          var m = (e && (e.message || '')) || '';
          err.textContent = /GM_AUTH_FAIL|GM_FORBIDDEN/.test(m)
            ? '口令错误或非管理员账号，无法进入'
            : '请求失败：' + friendlyError(e);
          err.hidden = false;
        })
        .then(resetBtn, resetBtn);
    } catch (e) {
      err.textContent = '请求异常，请重试';
      err.hidden = false;
      resetBtn();
    }
  }

  function openGmPanel() {
    $('gm-search-input').value = '';
    $('gm-results').innerHTML = '';
    $('gm-detail').hidden = true;
    $('gm-detail').innerHTML = '';
    showModal('gm-panel');
    try { $('gm-search-input').focus(); } catch (e) {}
  }

  function closeGm() { hideModal('gm-panel'); }

  function gmSearch() {
    var q = $('gm-search-input').value.trim();
    var box = $('gm-results');
    box.innerHTML = '<div class="gm-empty">搜索中…</div>';
    $('gm-detail').hidden = true;
    $('gm-detail').innerHTML = '';
    sb.rpc('gm_search_users', { p_pwd: gmPwd, p_query: q })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        if (!rows.length) { box.innerHTML = '<div class="gm-empty">未找到匹配用户</div>'; return; }
        box.innerHTML = '';
        rows.forEach(function (u) {
          var card = el('div', 'gm-user');
          var main = el('div', 'gm-user-main');
          var av = el('div', 'avatar sm');
          av.style.background = colorOf(u.nickname || u.phone);
          av.textContent = initialOf(u.nickname || u.phone);
          var info = el('div', 'gm-user-info');
          info.appendChild(el('div', 'gm-user-name', u.nickname || '(无昵称)'));
          info.appendChild(el('div', 'gm-user-phone', u.phone || ''));
          main.appendChild(av); main.appendChild(info);
          var btn = el('button', 'btn-mini', '管理');
          btn.type = 'button';
          btn.onclick = function () { gmLoadDetail(u.id, u.nickname, u.phone); };
          card.appendChild(main); card.appendChild(btn);
          box.appendChild(card);
        });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(m)) box.innerHTML = '<div class="gm-empty">口令已失效，请重新进入</div>';
        else box.innerHTML = '<div class="gm-empty">搜索失败：' + friendlyError(e) + '</div>';
      });
  }

  function gmLoadDetail(uid, name, phone) {
    gmCurrent = { uid: uid, name: name, phone: phone };
    var box = $('gm-detail');
    box.hidden = false;
    box.innerHTML = '<div class="gm-loading">加载中…</div>';
    sb.rpc('gm_list_user_groups', { p_pwd: gmPwd, p_user_id: uid })
      .then(function (gr) {
        if (gr.error) throw gr.error;
        var groups = gr.data || [];
        return sb.rpc('gm_list_user_friends', { p_pwd: gmPwd, p_user_id: uid })
          .then(function (fr) {
            if (fr.error) throw fr.error;
            renderGmDetail(uid, name, phone, groups, fr.data || []);
          });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(m)) box.innerHTML = '<div class="gm-empty">口令已失效，请重新进入</div>';
        else box.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function renderGmDetail(uid, name, phone, groups, friends) {
    var box = $('gm-detail');
    box.innerHTML = '';

    var head = el('div', 'gm-detail-head');
    head.appendChild(el('div', 'gm-detail-name', (name || '(无昵称)') + '  ·  ' + (phone || '')));
    var accBtn = el('button', 'btn-danger gm-acc-del', '注销该账号');
    accBtn.type = 'button';
    accBtn.onclick = function () { gmForceDeleteAccount(uid, name); };
    head.appendChild(accBtn);
    box.appendChild(head);

    box.appendChild(el('div', 'gm-subtitle', '群聊（' + groups.length + '）'));
    if (!groups.length) box.appendChild(el('div', 'gm-empty', '无群聊'));
    groups.forEach(function (g) {
      var row = el('div', 'gm-row');
      var txt = el('div', 'gm-row-text');
      txt.appendChild(el('div', 'gm-row-name', g.name));
      txt.appendChild(el('div', 'gm-row-sub', (g.is_owner ? '群主' : '成员') + ' · ' + (g.member_count || 0) + ' 人'));
      row.appendChild(txt);
      var b = el('button', 'btn-mini gm-danger', '强制删除');
      b.type = 'button';
      b.onclick = function () { gmForceDeleteGroup(uid, g.group_id, g.name); };
      row.appendChild(b);
      box.appendChild(row);
    });

    box.appendChild(el('div', 'gm-subtitle', '好友（' + friends.length + '）'));
    if (!friends.length) box.appendChild(el('div', 'gm-empty', '无好友'));
    friends.forEach(function (f) {
      var row = el('div', 'gm-row');
      var txt = el('div', 'gm-row-text');
      txt.appendChild(el('div', 'gm-row-name', f.other_nickname || '(无昵称)'));
      txt.appendChild(el('div', 'gm-row-sub', (f.other_phone || '') + ' · ' + (f.status || '')));
      row.appendChild(txt);
      var b = el('button', 'btn-mini gm-danger', '删除好友');
      b.type = 'button';
      b.onclick = function () { gmForceDeleteFriend(uid, f.other_id, f.other_nickname); };
      row.appendChild(b);
      box.appendChild(row);
    });

    renderGmUserTitles(uid);
  }

  function gmForceDeleteGroup(uid, gid, gname) {
    if (!window.confirm('确认强制删除群聊「' + (gname || gid) + '」？该群所有成员与消息将一并删除。')) return;
    sb.rpc('gm_force_delete_group', { p_pwd: gmPwd, p_group_id: gid })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已强制删除群聊：' + (gname || ''));
        if (gmCurrent && gmCurrent.uid === uid) gmLoadDetail(gmCurrent.uid, gmCurrent.name, gmCurrent.phone);
      })
      .catch(function (e) { toast('删除失败：' + friendlyError(e)); });
  }

  function gmForceDeleteFriend(uid, otherId, otherName) {
    if (!window.confirm('确认删除该好友关系（' + (otherName || otherId) + '）？双方都会失去这段好友关系。')) return;
    sb.rpc('gm_force_delete_friendship', { p_pwd: gmPwd, p_user_a: uid, p_user_b: otherId })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已删除好友关系：' + (otherName || ''));
        if (gmCurrent && gmCurrent.uid === uid) gmLoadDetail(gmCurrent.uid, gmCurrent.name, gmCurrent.phone);
      })
      .catch(function (e) { toast('删除失败：' + friendlyError(e)); });
  }

  function gmForceDeleteAccount(uid, name) {
    if (!window.confirm('确认注销账号「' + (name || uid) + '」？该账号及全部数据将被永久删除，不可恢复。')) return;
    sb.rpc('gm_force_delete_account', { p_pwd: gmPwd, p_user_id: uid })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已注销账号：' + (name || ''));
        $('gm-detail').hidden = true;
        $('gm-detail').innerHTML = '';
        gmSearch();
      })
      .catch(function (e) { toast('注销失败：' + friendlyError(e)); });
  }

  // ---------- 称号管理（GM 后台） ----------
  function gmSwitchTab(tab) {
    var users = tab === 'users';
    $('gm-tab-users').classList.toggle('active', users);
    $('gm-tab-titles').classList.toggle('active', !users);
    $('gm-users').hidden = !users;
    $('gm-titles').hidden = users;
    if (!users) openTitleTab();
  }

  function openTitleTab() {
    var box = $('gm-title-list');
    box.innerHTML = '<div class="gm-empty">加载中…</div>';
    sb.rpc('gm_list_titles', { p_pwd: gmPwd })
      .then(function (r) {
        if (r.error) throw r.error;
        renderGmTitles(r.data || []);
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        box.innerHTML = /GM_AUTH_FAIL/.test(m)
          ? '<div class="gm-empty">口令已失效，请重新进入</div>'
          : '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function condText(t) {
    if (t.cond_type === 'streak') return '连续登录 ' + (t.cond_value || '?') + ' 天自动获得';
    return '仅 GM 手动授予';
  }

  function renderGmTitles(rows) {
    var box = $('gm-title-list');
    box.innerHTML = '';
    if (!rows.length) { box.appendChild(el('div', 'gm-empty', '暂无称号，点击右上角「+ 新建称号」')); return; }
    rows.forEach(function (t) {
      var card = el('div', 'gm-title-card');
      var head = el('div', 'gm-title-head');
      var nameEl = el('span', 'gm-title-name', t.name);
      nameEl.style.borderColor = t.frame_color;
      nameEl.style.color = t.frame_color;
      head.appendChild(nameEl);
      head.appendChild(el('span', 'gm-title-cond', condText(t)));
      card.appendChild(head);
      if (t.description) card.appendChild(el('div', 'gm-title-desc', t.description));
      card.appendChild(el('div', 'gm-title-usage', '已有 ' + (t.usage_count || 0) + ' 人获得'));

      var actions = el('div', 'gm-title-actions');
      var grantBtn = el('button', 'btn-mini', '授予');
      grantBtn.type = 'button';
      grantBtn.onclick = function () { toggleGrantBox(card, t); };
      var delBtn = el('button', 'btn-mini gm-danger', '删除');
      delBtn.type = 'button';
      delBtn.onclick = function () { gmDeleteTitle(t.id, t.name); };
      actions.appendChild(grantBtn); actions.appendChild(delBtn);
      card.appendChild(actions);

      // 授予子面板（输入手机号查用户）
      var gbox = el('div', 'gm-grant-box');
      gbox.hidden = true;
      var inp = el('input');
      inp.type = 'tel'; inp.placeholder = '输入手机号查询用户'; inp.autocomplete = 'off';
      gbox.appendChild(inp);
      var look = el('button', 'btn-mini', '查询');
      look.type = 'button';
      look.onclick = function () { gmGrantLookup(t, inp.value.trim(), gres); };
      var cancel = el('button', 'btn-mini', '取消');
      cancel.type = 'button';
      cancel.onclick = function () { gbox.hidden = true; };
      gbox.appendChild(look); gbox.appendChild(cancel);
      var gres = el('div', 'gm-grant-result');
      gbox.appendChild(gres);
      card.appendChild(gbox);

      box.appendChild(card);
    });
  }

  function toggleGrantBox(card, t) {
    var gbox = card.querySelector('.gm-grant-box');
    if (gbox) gbox.hidden = !gbox.hidden;
  }

  function gmGrantLookup(t, phone, resBox) {
    resBox.innerHTML = '查询中…';
    if (!phone) { resBox.innerHTML = '请输入手机号'; return; }
    sb.rpc('gm_search_users', { p_pwd: gmPwd, p_query: phone })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = (r.data || []).filter(function (u) {
          return (u.phone || '').indexOf(phone) >= 0;
        });
        if (!rows.length) { resBox.innerHTML = '未找到该手机号用户'; return; }
        var u = rows[0];
        resBox.innerHTML = '';
        resBox.appendChild(el('div', 'gm-grant-user',
          (u.nickname || '(无昵称)') + ' · ' + (u.phone || '')));
        var ok = el('button', 'btn-mini gm-confirm', '确认授予「' + t.name + '」');
        ok.type = 'button';
        ok.onclick = function () { gmGrantTitle(u.id, t); };
        resBox.appendChild(ok);
      })
      .catch(function (e) {
        resBox.innerHTML = '查询失败：' + friendlyError(e);
      });
  }

  function gmGrantTitle(uid, t) {
    sb.rpc('gm_grant_title', { p_pwd: gmPwd, p_user_id: uid, p_title_id: t.id })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已授予「' + t.name + '」');
        loadDisplayTitles().then(applySelfTitle).then(renderConversations); // 同步前端头像框
        openTitleTab();
      })
      .catch(function (e) { toast('授予失败：' + friendlyError(e)); });
  }

  function gmDeleteTitle(id, name) {
    if (!window.confirm('确认删除称号「' + name + '」？已获得该称号的用户也会一并失去。')) return;
    sb.rpc('gm_delete_title', { p_pwd: gmPwd, p_title_id: id })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已删除称号：' + name);
        openTitleTab();
      })
      .catch(function (e) { toast('删除失败：' + friendlyError(e)); });
  }

  // 新建称号表单
  function openTitleForm() {
    $('gm-title-name').value = '';
    $('gm-title-desc').value = '';
    $('gm-title-color').value = '#ffd700';
    $('gm-title-style').value = 'ring';
    $('gm-title-cond').value = 'manual';
    $('gm-title-days-wrap').hidden = true;
    $('gm-title-days').value = '7';
    $('gm-title-error').hidden = true;
    showModal('gm-title-modal');
  }

  function gmCreateTitle() {
    var name = $('gm-title-name').value.trim();
    var desc = $('gm-title-desc').value.trim();
    var color = $('gm-title-color').value;
    var style = $('gm-title-style').value;
    var cond = $('gm-title-cond').value;
    var days = parseInt($('gm-title-days').value, 10);
    var err = $('gm-title-error');
    err.hidden = true;
    if (!name) { err.textContent = '请填写称号名称'; err.hidden = false; return; }
    if (cond === 'streak' && (!days || days < 1)) { err.textContent = '请填写有效的连续天数'; err.hidden = false; return; }
    var btn = $('gm-title-create');
    btn.disabled = true; btn.textContent = '创建中…';
    sb.rpc('gm_create_title', {
      p_pwd: gmPwd, p_name: name, p_desc: desc, p_color: color,
      p_style: style, p_cond_type: cond, p_value: cond === 'streak' ? days : null
    })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('gm-title-modal');
        toast('已创建称号：' + name);
        openTitleTab();
      })
      .catch(function (e) { err.textContent = '创建失败：' + friendlyError(e); err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = '创建'; });
  }

  // 在用户详情里追加「称号」区块（查看/撤回）
  function renderGmUserTitles(uid) {
    var box = $('gm-detail');
    box.appendChild(el('div', 'gm-subtitle', '称号'));
    var wrap = el('div', 'gm-titles-sub');
    box.appendChild(wrap);
    wrap.appendChild(el('div', 'gm-loading', '加载中…'));
    sb.rpc('gm_list_user_titles', { p_pwd: gmPwd, p_user_id: uid })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        wrap.innerHTML = '';
        if (!rows.length) { wrap.appendChild(el('div', 'gm-empty', '该用户暂无称号')); return; }
        rows.forEach(function (t) {
          var row = el('div', 'gm-row');
          var txt = el('div', 'gm-row-text');
          txt.appendChild(el('div', 'gm-row-name', t.name));
          txt.appendChild(el('div', 'gm-row-sub', (t.source === 'auto' ? '自动获得' : 'GM 授予')));
          row.appendChild(txt);
          var b = el('button', 'btn-mini gm-danger', '撤回');
          b.type = 'button';
          b.onclick = function () { gmRevokeTitle(uid, t.title_id, t.name); };
          row.appendChild(b);
          wrap.appendChild(row);
        });
      })
      .catch(function (e) {
        wrap.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function gmRevokeTitle(uid, titleId, name) {
    if (!window.confirm('确认撤回称号「' + name + '」？')) return;
    sb.rpc('gm_revoke_title', { p_pwd: gmPwd, p_user_id: uid, p_title_id: titleId })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已撤回称号：' + name);
        if (gmCurrent) renderGmUserTitles(gmCurrent.uid);
        loadDisplayTitles().then(applySelfTitle).then(renderConversations);
      })
      .catch(function (e) { toast('撤回失败：' + friendlyError(e)); });
  }

  function changePassword() {
    var np = $('settings-newpwd').value;
    var cp = $('settings-confirm-pwd').value;
    var err = $('change-pwd-error');
    err.hidden = true;
    if (np.length < 6) { err.textContent = '新密码至少 6 位'; err.hidden = false; return; }
    if (np !== cp) { err.textContent = '两次输入的密码不一致'; err.hidden = false; return; }

    var btn = $('change-pwd-btn');
    btn.disabled = true; btn.textContent = '更新中…';
    sb.auth.updateUser({ password: np })
      .then(function (r) {
        if (r.error) throw r.error;
        resetPwdFields();
        if (state.forceChangePwd) {
          state.forceChangePwd = false;
          $('force-pwd-banner').hidden = true;
          hideModal('settings-modal');
          toast('密码已修改，账号已恢复');
        } else {
          toast('密码已更新，下次登录生效');
        }
      })
      .catch(function (e) {
        var m = (e && e.message) || '';
        if (/re-authenticat|recent login|sign in recently/i.test(m)) {
          err.textContent = '出于安全需要，请先退出登录并重新登录后再修改密码';
        } else {
          err.textContent = friendlyError(e);
        }
        err.hidden = false;
      })
      .then(function () { btn.disabled = false; btn.textContent = '更新密码'; });
  }

  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('switch-account-settings').addEventListener('click', switchAccountFromSettings);
  $('settings-cancel').addEventListener('click', closeSettings);

  // 注销账号：入口与各步骤按钮
  $('delete-account-btn').addEventListener('click', openDeleteAccount);
  $('del-account-close').addEventListener('click', function () { hideModal('del-account-modal'); });
  $('del-account-cancel').addEventListener('click', function () { hideModal('del-account-modal'); });
  $('del-account-confirm').addEventListener('click', deleteAccountToVerify);
  $('del-account-verify-close').addEventListener('click', function () { hideModal('del-account-verify'); });
  $('del-account-verify-cancel').addEventListener('click', function () { hideModal('del-account-verify'); });
  $('del-account-verify-btn').addEventListener('click', deleteAccountVerify);
  $('del-account-final-close').addEventListener('click', function () { hideModal('del-account-final'); });
  $('del-account-final-cancel').addEventListener('click', function () { hideModal('del-account-final'); });
  $('del-account-final-btn').addEventListener('click', deleteAccountCommit);
  $('settings-modal').addEventListener('click', function (e) {
    if (e.target === this) closeSettings();
  });

  // 绝对管理员（GM）后台：入口与各步骤
  $('gm-open-btn').addEventListener('click', openGmEntry);
  $('gm-pwd-close').addEventListener('click', function () { hideModal('gm-pwd-modal'); });
  $('gm-pwd-cancel').addEventListener('click', function () { hideModal('gm-pwd-modal'); });
  $('gm-pwd-confirm').addEventListener('click', gmTryAuth);
  $('gm-pwd-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') gmTryAuth(); });
  $('gm-close').addEventListener('click', closeGm);
  $('gm-panel').addEventListener('click', function (e) { if (e.target === this) closeGm(); });
  $('gm-search-btn').addEventListener('click', gmSearch);
  $('gm-search-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') gmSearch(); });

  // 称号管理标签页与表单
  $('gm-tab-users').addEventListener('click', function () { gmSwitchTab('users'); });
  $('gm-tab-titles').addEventListener('click', function () { gmSwitchTab('titles'); });
  $('gm-title-new-btn').addEventListener('click', openTitleForm);
  $('gm-title-close').addEventListener('click', function () { hideModal('gm-title-modal'); });
  $('gm-title-cancel').addEventListener('click', function () { hideModal('gm-title-modal'); });
  $('gm-title-create').addEventListener('click', gmCreateTitle);
  $('gm-title-cond').addEventListener('change', function () {
    $('gm-title-days-wrap').hidden = (this.value !== 'streak');
  });

  $('settings-avatar-btn').addEventListener('click', function () {
    $('settings-avatar-file').click();
  });

  $('settings-avatar-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('头像图片请小于 2 MB'); return; }

    var ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    var rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
             : Date.now() + (Math.random() * 1e6 | 0);
    var path = state.uid + '/avatars/' + rand + (ext ? '.' + ext : '');

    var btn = $('settings-avatar-btn');
    btn.disabled = true; btn.textContent = '上传中…';
    sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'image/png', upsert: true })
      .then(function (r) {
        if (r.error) throw r.error;
        pendingAvatar = path;
        var url = URL.createObjectURL(file);   // 立即本地预览
        var av = $('settings-avatar');
        av.textContent = '';
        av.style.background = 'transparent';
        var old = av.querySelector('img');
        if (old) old.remove();
        var im = new Image();
        im.className = 'avatar-img';
        im.src = url;
        av.appendChild(im);
        toast('头像已选择，点「保存」生效');
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '更换头像'; });
  });

  $('change-pwd-btn').addEventListener('click', changePassword);
  $('logout-other-devices').addEventListener('click', logoutOtherDevices);

  $('settings-save').addEventListener('click', function () {
    var name = $('settings-name').value.trim();
    if (!name) { toast('名称不能为空'); return; }
    var payload = { nickname: name.slice(0, 20) };
    if (pendingAvatar !== null) payload.avatar_path = pendingAvatar;

    var btn = $('settings-save');
    btn.disabled = true; btn.textContent = '保存中…';
    sb.from('profiles').update(payload).eq('id', state.uid)
      .then(function (r) {
        if (r.error) throw r.error;
        state.profile.nickname = name;
        if (pendingAvatar !== null) state.profile.avatar_path = pendingAvatar;
        $('me-name').textContent = name;
        setAvatar($('me-avatar'), {
          nickname: state.profile.nickname,
          phone: state.profile.phone,
          avatarPath: state.profile.avatar_path
        });
        toast('已保存');
        closeSettings();
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '保存'; });
  });

  /* ============================================================
   *  群聊
   * ============================================================ */
  function groupById(id) {
    for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
    return null;
  }
  function friendById(id) {
    for (var i = 0; i < state.friends.length; i++) if (state.friends[i].id === id) return state.friends[i];
    return null;
  }

  function loadGroups() {
    return sb.from('groups')
      .select('id,name,owner_id, group_members(user_id, pinned)')
      .order('created_at', { ascending: false })
      .then(function (r) {
        if (!r.error) return parseGroups(true, r);
        var msg = (r.error.message || '') + ' ' + (r.error.details || '') + ' ' + (r.error.hint || '');
        // 如果 pinned 列还没建，自动降级到不带 pinned 的查询，保证列表能显示
        if (msg.indexOf('pinned') !== -1) {
          return sb.from('groups')
            .select('id,name,owner_id, group_members(user_id)')
            .order('created_at', { ascending: false })
            .then(function (r2) { return parseGroups(false, r2); });
        }
        throw r.error;
      });
  }

  function parseGroups(withPin, r) {
    if (r.error) throw r.error;
    state.groups = (r.data || []).map(function (g) {
      var members = (g.group_members || []).map(function (m) { return m.user_id; });
      var mine = (g.group_members || []).filter(function (m) { return m.user_id === state.uid; })[0];
      var pinned = withPin && mine ? !!mine.pinned : false;
      return {
        type: 'group',
        id: g.id,
        name: g.name,
        ownerId: g.owner_id,
        memberIds: members,
        memberCount: members.length,
        iAmOwner: g.owner_id === state.uid,
        pinned: pinned
      };
    });
    state.groups.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
    if (state.active && state.active.type === 'group') {
      var fresh = groupById(state.active.id);
      if (fresh) state.active = fresh;
    }
    renderGroups();
    return state.groups;
  }

  function renderGroups() { renderConversations(); }

  function toggleGroupPin(g) {
    sb.rpc('toggle_group_pin', { p_group_id: g.id })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var val = res && res.data !== undefined ? res.data : res;
        g.pinned = !!val;
        if (state.active && state.active.type === 'group' && state.active.id === g.id) state.active.pinned = g.pinned;
        state.groups.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
        renderGroups();
      })
      .catch(function (e) {
        var msg = friendlyError(e);
        if (/pinned|toggle_group_pin|column .* does not exist/i.test(msg)) {
          toast('群置顶功能需要先在 Supabase 运行 20260801_group_pin.sql 迁移');
          return;
        }
        toast(msg);
      });
  }

  function loadGroupMemberProfiles(groupId) {
    sb.from('group_members').select('user_id, profiles(id,nickname,avatar_path,phone)')
      .eq('group_id', groupId)
      .then(function (r) {
        if (r.error) return;
        (r.data || []).forEach(function (m) {
          var p = m.profiles;
          if (p) state.profilesById[p.id] = { nickname: p.nickname, avatar_path: p.avatar_path, phone: p.phone };
        });
      });
  }

  /* ---------- 创建群聊 ---------- */
  function openNewGroup() {
    $('new-group-name').value = '';
    renderFriendPicker($('group-friend-picker'), state.friends, []);
    showModal('new-group-modal');
  }

  function renderFriendPicker(container, friends, excludeIds) {
    container.innerHTML = '';
    if (!friends.length) { container.appendChild(el('div', 'note', '还没有好友')); return; }
    friends.forEach(function (f) {
      if (excludeIds.indexOf(f.id) >= 0) return;
      var label = el('label', 'picker-item');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = f.id; cb.className = 'picker-cb';
      var av = el('div', 'avatar sm');
      setAvatar(av, { nickname: f.remark || f.nickname, phone: f.phone, avatarPath: f.avatar });
      var info = el('div', 'info');
      info.appendChild(el('div', 'nm', f.remark || f.nickname));
      info.appendChild(el('div', 'ph', f.phone));
      label.appendChild(cb); label.appendChild(av); label.appendChild(info);
      container.appendChild(label);
    });
  }

  function createGroup() {
    var name = $('new-group-name').value.trim() || ('群聊' + (state.groups.length + 1));
    var checks = $('group-friend-picker').querySelectorAll('input[type=checkbox]:checked');
    if (!checks.length) { toast('至少选择一位好友'); return; }
    var memberIds = [];
    checks.forEach(function (c) { memberIds.push(c.value); });
    var btn = $('new-group-create');
    btn.disabled = true; btn.textContent = '创建中…';
    // 用 security definer 的 create_group RPC 一次性建群+加成员，绕开 RLS 写入限制
    sb.rpc('create_group', { p_name: name, p_member_ids: memberIds })
      .then(function (r) {
        if (r.error) throw r.error;
        var gid = r.data;
        hideModal('new-group-modal');
        return loadGroups().then(function () { return gid; });
      })
      .then(function (gid) {
        var g = groupById(gid);
        if (g) openChat(g);
        toast('群聊已创建');
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '创建'; });
  }

  /* ---------- 群资料 / 管理 ---------- */
  function openGroupInfo() {
    if (!state.active || state.active.type !== 'group') return;
    var g = state.active;
    $('group-info-name').value = g.name;
    $('group-info-name').disabled = !g.iAmOwner;
    $('group-name-field').hidden = !g.iAmOwner;
    $('group-info-save').hidden = !g.iAmOwner;
    $('group-info-add').hidden = !g.iAmOwner;
    // 群主显示「解散群聊」、隐藏「退出群聊」；普通成员反之
    $('group-info-dissolve').hidden = !g.iAmOwner;
    $('group-info-leave').hidden = g.iAmOwner;
    renderMemberList(g);
    showModal('group-info-modal');
  }

  function dissolveGroup() {
    if (!state.active || state.active.type !== 'group') return;
    var g = state.active;
    if (!g.iAmOwner) { toast('只有群主能解散群聊'); return; }
    if (!window.confirm('确定要解散「' + g.name + '」吗？\n该操作不可恢复，所有成员和聊天记录将被删除。')) return;
    sb.rpc('dissolve_group', { p_group_id: g.id })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('group-info-modal');
        state.active = null;
        $('chat-room').hidden = true;
        $('chat-empty').hidden = false;
        return loadGroups();
      })
      .then(function () { toast('群聊已解散'); })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function renderMemberList(g) {
    var list = $('group-member-list');
    list.innerHTML = '';
    $('group-member-count').textContent = g.memberIds.length;
    g.memberIds.forEach(function (uid) {
      var p = state.profilesById[uid] || { nickname: '用户', phone: '' };
      var li = el('li', 'member-item');
      var av = el('div', 'avatar sm');
      av.textContent = (p.nickname || '?').charAt(0);
      av.style.background = colorOf(p.phone || uid);
      var info = el('div', 'info');
      var tag = (uid === g.ownerId) ? '（群主）' : (uid === state.uid ? '（我）' : '');
      info.appendChild(el('div', 'nm', (p.nickname || '用户') + tag));
      li.appendChild(av); li.appendChild(info);
      if (g.iAmOwner && uid !== g.ownerId) {
        var tr = el('button', 'mini-ok', '转让'); tr.type = 'button';
        tr.onclick = function () { transferOwner(g, uid); };
        li.appendChild(tr);
      }
      if (g.iAmOwner && uid !== g.ownerId && uid !== state.uid) {
        var rm = el('button', 'mini-no', '移除'); rm.type = 'button';
        rm.onclick = function () { removeMember(g, uid); };
        li.appendChild(rm);
      }
      list.appendChild(li);
    });
  }

  function removeMember(g, uid) {
    sb.rpc('remove_group_member', { p_group_id: g.id, p_user_id: uid })
      .then(function (r) { if (r.error) throw r.error; toast('已移除成员'); return loadGroups(); })
      .then(function () {
        var ng = groupById(g.id);
        if (ng) { state.active = ng; renderMemberList(ng); renderGroups(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function transferOwner(g, uid) {
    sb.rpc('transfer_group_owner', { p_group_id: g.id, p_new_owner: uid })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已转让群主');
        return loadGroups();
      })
      .then(function () {
        var ng = groupById(g.id);
        if (ng) { state.active = ng; openGroupInfo(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function leaveGroup() {
    if (!state.active || state.active.type !== 'group') return;
    var g = state.active;
    if (g.iAmOwner) { toast('你是群主，请先转让群主再退群'); return; }
    sb.rpc('remove_group_member', { p_group_id: g.id, p_user_id: state.uid })
      .then(function (r) { if (r.error) throw r.error; toast('已退出群聊'); hideModal('group-info-modal'); return loadGroups(); })
      .then(function () {
        state.active = null;
        $('chat-room').hidden = true;
        $('chat-empty').hidden = false;
        renderGroups();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  /* ---------- 群聊按钮事件绑定 ---------- */
  $('new-group-btn').addEventListener('click', openNewGroup);
  $('new-group-create').addEventListener('click', createGroup);
  $('new-group-close').addEventListener('click', function () { hideModal('new-group-modal'); });
  $('new-group-cancel').addEventListener('click', function () { hideModal('new-group-modal'); });
  $('new-group-modal').addEventListener('click', function (e) { if (e.target === this) this.close(); });

  $('group-info-btn').addEventListener('click', openGroupInfo);
  $('group-info-close').addEventListener('click', function () { hideModal('group-info-modal'); });
  $('group-info-modal').addEventListener('click', function (e) { if (e.target === this) this.close(); });
  $('group-info-save').addEventListener('click', function () {
    if (!state.active || !state.active.iAmOwner) return;
    var name = $('group-info-name').value.trim();
    if (!name) { toast('群名称不能为空'); return; }
    sb.rpc('update_group', { p_group_id: state.active.id, p_name: name })
      .then(function (r) { if (r.error) throw r.error; toast('已保存'); return loadGroups(); })
      .then(function () {
        var ng = groupById(state.active.id);
        if (ng) { $('peer-name').textContent = ng.name; openGroupInfo(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  });
  $('group-info-leave').addEventListener('click', leaveGroup);
  $('group-info-dissolve').addEventListener('click', dissolveGroup);

  $('group-info-add').addEventListener('click', function () {
    if (!state.active) return;
    var g = state.active;
    var candidates = state.friends.filter(function (f) { return g.memberIds.indexOf(f.id) < 0; });
    renderFriendPicker($('add-member-picker'), candidates, []);
    showModal('add-member-modal');
  });
  $('add-member-confirm').addEventListener('click', function () {
    if (!state.active) return;
    var g = state.active;
    var checks = $('add-member-picker').querySelectorAll('input[type=checkbox]:checked');
    if (!checks.length) { toast('请选择要添加的好友'); return; }
    var ids = []; checks.forEach(function (c) { ids.push(c.value); });
    sb.rpc('add_group_members', { p_group_id: g.id, p_user_ids: ids })
      .then(function (r) { if (r.error) throw r.error; toast('已添加成员'); hideModal('add-member-modal'); return loadGroups(); })
      .then(function () {
        var ng = groupById(g.id);
        if (ng) { state.active = ng; renderMemberList(ng); renderGroups(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  });
  $('add-member-close').addEventListener('click', function () { hideModal('add-member-modal'); });
  $('add-member-cancel').addEventListener('click', function () { hideModal('add-member-modal'); });
  $('add-member-modal').addEventListener('click', function (e) { if (e.target === this) this.close(); });

  /* ---------- 统一搜索：搜好友 + 手机号加好友 ---------- */
  $('search-box').addEventListener('input', onUnifiedSearch);

  function sendRequest(user, btn) {
    btn.disabled = true;
    // 先看是否已有任一方向的关系记录
    sb.from('friendships').select('id,status,requester_id')
      .or('and(requester_id.eq.' + state.uid + ',addressee_id.eq.' + user.id + '),' +
          'and(requester_id.eq.' + user.id + ',addressee_id.eq.' + state.uid + ')')
      .maybeSingle()
      .then(function (r) {
        if (r.error && r.error.code !== 'PGRST116') throw r.error;
        if (r.data) {
          if (r.data.status === 'pending' && r.data.requester_id === state.uid) {
            toast('申请已发出，等待对方同意');
          } else if (r.data.status === 'pending') {
            toast('对方也申请了你，请到「新的好友」里同意');
          } else if (r.data.status === 'accepted') {
            toast('已经是好友了');
          } else {
            // 之前被拒绝过，重新发起
            return sb.from('friendships')
              .update({ status: 'pending', updated_at: new Date().toISOString() })
              .eq('id', r.data.id)
              .then(function (u) {
                if (u.error) throw u.error;
                toast('好友申请已发送');
              });
          }
          return null;
        }
        return sb.from('friendships')
          .insert({ requester_id: state.uid, addressee_id: user.id, status: 'pending' })
          .then(function (ins) {
            if (ins.error) throw ins.error;
            toast('好友申请已发送');
          });
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; });
  }

  /* ============================================================
   *  会话与消息
   * ============================================================ */
  function openChat(peer) {
    var isGroup = peer.type === 'group';
    state.active = peer;
    if (state.recallTimer) { clearInterval(state.recallTimer); state.recallTimer = null; }
    delete state.unread[peer.id];
    // 注意：仅“收到消息”或“发送消息”才把会话前置（见下方发送处与实时接收处），
    // 点击打开查看不再触发前置，避免一进对话框就打乱列表顺序。
    if (isGroup) renderGroups(); else renderFriends();

    $('chat-empty').hidden = true;
    $('chat-room').hidden = false;
    document.querySelector('.app-view').classList.add('show-chat');

    $('peer-name').textContent = isGroup ? peer.name : displayName(peer);
    $('peer-phone').textContent = isGroup ? (peer.memberCount + ' 位成员')
      : peer.phone + (isOnline(peer.id) ? ' · 在线' : '');

    var av = $('peer-avatar');
    if (isGroup) {
      av.textContent = peer.name ? peer.name.charAt(0) : '群';
      av.style.background = '#7f77dd';
      var oldImg = av.querySelector('img'); if (oldImg) oldImg.remove();
    } else {
      setAvatar(av, { nickname: peer.remark || peer.nickname, phone: peer.phone, avatarPath: peer.avatar });
      addOnlineDot(av, peer.id);
      applyTitleFrame(av, peer.id);
      addTitleBadge($('peer-name'), peer.id);
    }

    var rb = $('peer-remark-btn');
    if (rb) { rb.hidden = isGroup; if (!isGroup) rb.onclick = function () { editRemark(peer); }; }
    var db = $('peer-del-btn');
    if (db) { db.hidden = isGroup; if (!isGroup) db.onclick = function () { deleteFriend(peer); }; }
    $('group-info-btn').hidden = !isGroup;

    var box = $('messages');
    box.innerHTML = '';
    box.appendChild(el('div', 'day-sep', '加载中…'));

    var query = sb.from('messages')
      .select('*, sender:profiles!messages_sender_id_fkey(id,nickname,avatar_path)');
    if (isGroup) {
      query = query.eq('group_id', peer.id);
      loadGroupMemberProfiles(peer.id);
    } else {
      query = query.or('and(sender_id.eq.' + state.uid + ',receiver_id.eq.' + peer.id + '),' +
                        'and(sender_id.eq.' + peer.id + ',receiver_id.eq.' + state.uid + ')');
    }

    query.order('created_at', { ascending: false }).limit(LIMIT)
      .then(function (r) {
        if (r.error) throw r.error;
        if (!state.active || state.active.id !== peer.id) return;
        box.innerHTML = '';
        var rows = (r.data || []).slice().reverse();
        if (!rows.length) box.appendChild(el('div', 'day-sep', '还没有消息，打个招呼吧'));
        var lastDay = null;
        rows.forEach(function (m) {
          var k = dayKey(m.created_at);
          if (k !== lastDay) { box.appendChild(el('div', 'day-sep', dayLabel(m.created_at))); lastDay = k; }
          box.appendChild(renderMessage(m));
        });
        scrollBottom();
        if (state.recallTimer) clearInterval(state.recallTimer);
        state.recallTimer = setInterval(refreshRecallButtons, 15000);
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  $('back-btn').addEventListener('click', function () {
    document.querySelector('.app-view').classList.remove('show-chat');
  });

  // 聊天页点击好友头像 → 打开个人主页（群聊不触发）
  $('peer-avatar').addEventListener('click', function () {
    if (state.active && state.active.type !== 'group') openProfile(state.active);
  });
  $('profile-close').addEventListener('click', function () { hideModal('profile-modal'); });

  // 个人主页：显示昵称、手机号、拥有称号
  function openProfile(peer) {
    var av = $('profile-avatar');
    setAvatar(av, { nickname: peer.remark || peer.nickname, phone: peer.phone, avatarPath: peer.avatar });
    applyTitleFrame(av, peer.id);
    $('profile-name').textContent = displayName(peer);
    $('profile-phone').textContent = peer.phone || '未绑定手机号';

    showModal('profile-modal');

    var box = $('profile-titles');
    box.innerHTML = '<div class="title-loading">加载中…</div>';
    sb.rpc('get_user_titles', { p_user_id: peer.id })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        if (!rows.length) {
          box.innerHTML = '';
          box.appendChild(el('div', 'profile-empty', '暂无称号'));
          return;
        }
        box.innerHTML = '';
        rows.forEach(function (t) {
          var row = el('div', 'profile-title');
          var dot = el('span', 'dot');
          dot.style.background = t.frame_color || '#ffd700';
          row.appendChild(dot);
          var main = el('div', 'pt-main');
          main.appendChild(el('div', 'tn', t.name));
          if (t.description) main.appendChild(el('div', 'td', t.description));
          // 获得时间与来源
          var meta = el('div', 'pt-meta');
          meta.appendChild(el('span', 'pt-time', '获得于 ' + fmtDateTime(t.granted_at)));
          meta.appendChild(el('span', 'src', t.source === 'auto' ? '自动获得' : '授予'));
          main.appendChild(meta);
          row.appendChild(main);
          box.appendChild(row);
        });
      })
      .catch(function () {
        box.innerHTML = '';
        box.appendChild(el('div', 'profile-empty', '称号加载失败'));
      });
  }

  function scrollBottom() {
    var box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  function appendMessage(m) {
    var box = $('messages');
    var sep = box.querySelector('.day-sep');
    if (sep && sep.textContent === '还没有消息，打个招呼吧') sep.remove();
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.appendChild(renderMessage(m));
    if (near) scrollBottom();
  }

  // 视频/音频类扩展名，命中后即使消息被存成 file 类型也内联播放，绝不开新网页
  var VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', '3gp', 'mkv', 'avi'];

  function isVideoFile(m) {
    if (m.kind === 'video') return true;
    var ext = (m.file_name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    return VIDEO_EXT.indexOf(ext) >= 0;
  }

  // 统一的内联视频气泡：气泡内直接 <video> 播放；点空白处进 lightbox 全屏播；全程不跳新网页
  function buildVideoBubble(m) {
    var bubble = el('div', 'bubble media');
    var vid = document.createElement('video');
    vid.controls = true;
    vid.preload = 'metadata';
    vid.playsInline = true;
    bubble.appendChild(vid);
    signedUrl(m.file_path).then(function (u) {
      if (!u) return;
      vid.src = u;
      // 点视频控件本身只控制播放，不触发全屏 lightbox
      vid.onclick = function (e) { e.stopPropagation(); };
    });
    // 点气泡空白处 → 全屏内联播放（不开新网页）
    bubble.onclick = function () {
      signedUrl(m.file_path).then(function (u) {
        if (!u) return;
        var lb = $('lightbox');
        var im = $('lightbox-img'), vv = $('lightbox-video');
        im.hidden = true; vv.hidden = false; vv.src = u;
        lb.hidden = false;
        vv.play().catch(function () {});
      });
    };
    return bubble;
  }

  function renderMessage(m) {
    var out = m.sender_id === state.uid;
    var wrap = el('div', 'msg ' + (out ? 'out' : 'in'));
    wrap.dataset.id = m.id;
    if (out && m.created_at) wrap.dataset.ts = new Date(m.created_at).getTime();

    // 本端已删除：仅自己可见，显示占位（对方无感）
    if (m.deleted_by && m.deleted_by.indexOf(state.uid) >= 0) {
      wrap.className = 'msg recalled';
      wrap.appendChild(el('div', 'recalled-note', '你已删除此消息'));
      return wrap;
    }

    if (m.recalled) {
      wrap.className = 'msg recalled';
      wrap.appendChild(el('div', 'recalled-note',
        out ? '你撤回了一条消息' : '对方撤回了一条消息'));
      return wrap;
    }

    var bubble;
    if (m.kind === 'text') {
      bubble = el('div', 'bubble', m.content || '');
    } else if (m.kind === 'image') {
      bubble = el('div', 'bubble media');
      var img = document.createElement('img');
      img.alt = m.file_name || '图片';
      img.loading = 'lazy';
      bubble.appendChild(img);
      signedUrl(m.file_path).then(function (u) {
        if (!u) return;
        img.src = u;
        img.onclick = function () {
          var lb = $('lightbox');
          var im = $('lightbox-img'), vv = $('lightbox-video');
          vv.hidden = true; im.hidden = false; im.src = u;
          lb.hidden = false;
        };
      });
    } else if (m.kind === 'video') {
      bubble = buildVideoBubble(m);
    } else {
      // 视频文件即使被存成 file 类型，也内联播放，不开新网页
      if (isVideoFile(m)) {
        bubble = buildVideoBubble(m);
      } else {
        bubble = el('div', 'bubble');
        var a = document.createElement('a');
        a.className = 'file-card';
        a.target = '_blank';
        a.rel = 'noopener';
        var ext = (m.file_name || '').split('.').pop() || 'file';
        a.appendChild(el('div', 'file-icon', ext.slice(0, 4)));
        var meta = el('div', 'file-meta');
        meta.appendChild(el('div', 'file-name', m.file_name || '文件'));
        meta.appendChild(el('div', 'file-size', fmtSize(m.file_size)));
        a.appendChild(meta);
        bubble.appendChild(a);
        signedUrl(m.file_path).then(function (u) { if (u) { a.href = u; a.download = m.file_name || ''; } });
      }
    }

    var isGroup = !!(state.active && state.active.type === 'group');
    if (!out && isGroup) {
      var sName = (m.sender && m.sender.nickname) ||
                  (state.profilesById[m.sender_id] && state.profilesById[m.sender_id].nickname) ||
                  '成员';
      wrap.classList.add('group-in');
      wrap.appendChild(el('div', 'msg-sender', sName));
    }
    wrap.appendChild(bubble);
    wrap.appendChild(el('div', 'msg-time', fmtTime(m.created_at)));

    if (out) {
      var withinRecall = (Date.now() - new Date(m.created_at).getTime()) < 5 * 60 * 1000;
      if (withinRecall) {
        var rb = el('button', 'recall-btn', '撤回');
        rb.type = 'button';
        rb.onclick = function () { recallMessage(m.id); };
        wrap.appendChild(rb);
      } else {
        var db = el('button', 'del-btn', '删除');
        db.type = 'button';
        db.title = '仅自己删除，对方仍可看到';
        db.onclick = function () { deleteMessageForMe(m.id); };
        wrap.appendChild(db);
      }
    } else {
      var db = el('button', 'del-btn', '删除');
      db.type = 'button';
      db.title = '仅自己删除，对方仍可看到';
      db.onclick = function () { deleteMessageForMe(m.id); };
      wrap.appendChild(db);
    }
    return wrap;
  }

  // 每 15s 检查一次：自己发出的消息若已超出 5 分钟撤回窗口，
  // 把仍显示“撤回”的按钮替换为“删除”（本端删除，对方无感）
  function refreshRecallButtons() {
    var box = $('messages');
    Array.prototype.forEach.call(box.querySelectorAll('.msg.out'), function (node) {
      var ts = parseInt(node.dataset.ts || '0', 10);
      if (!ts) return;
      if (Date.now() - ts >= 5 * 60 * 1000) {
        var rb = node.querySelector('.recall-btn');
        if (rb) {
          var id = node.dataset.id;
          var del = el('button', 'del-btn', '删除');
          del.type = 'button';
          del.title = '仅自己删除，对方仍可看到';
          del.onclick = function () { deleteMessageForMe(id); };
          rb.replaceWith(del);
        }
      }
    });
  }

  function recallMessage(id) {
    var box = $('messages');
    var old = box.querySelector('[data-id="' + id + '"]');
    sb.from('messages')
      .update({ recalled: true, content: null, file_path: null, file_name: null, file_size: null })
      .eq('id', id)
      .then(function (r) {
        if (r.error) throw r.error;
        if (old) old.replaceWith(renderMessage({ id: id, sender_id: state.uid, recalled: true }));
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  /* ---------- 本端删除（仅自己不可见，对方无感） ---------- */
  function deleteMessageForMe(id) {
    if (!window.confirm('删除后仅自己不可见，对方仍能看到。确定删除吗？')) return;
    var box = $('messages');
    var old = box.querySelector('[data-id="' + id + '"]');
    sb.rpc('delete_message_for_me', { msg_id: id })
      .then(function (r) {
        if (r.error) throw r.error;
        if (old) old.replaceWith(renderMessage({ id: id, sender_id: state.uid, deleted_by: [state.uid] }));
        toast('已删除（仅自己可见）');
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  $('lightbox').addEventListener('click', function () {
    this.hidden = true;
    var vv = $('lightbox-video');
    if (vv) { vv.pause(); vv.removeAttribute('src'); vv.load(); }
  });

  function signedUrl(path) {
    if (!path) return Promise.resolve(null);
    if (state.urlCache[path]) return Promise.resolve(state.urlCache[path]);
    return sb.storage.from(BUCKET).createSignedUrl(path, 3600).then(function (r) {
      if (r.error || !r.data) return null;
      state.urlCache[path] = r.data.signedUrl;
      return r.data.signedUrl;
    });
  }

  /* ---------- 发送文字 ---------- */
  var input = $('msg-input');

  input.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 720) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || !state.active) return;
    input.value = '';
    input.style.height = 'auto';

    var peerId = state.active.id;
    var isGroup = state.active.type === 'group';

    var payload = {
      sender_id: state.uid,
      kind: 'text',
      content: text
    };
    if (isGroup) payload.group_id = peerId;
    else payload.receiver_id = peerId;

    sb.from('messages').insert(payload).select().single()
      .then(function (r) {
        if (r.error) throw r.error;
        appendMessage(r.data);
        // 发送消息也会把该会话前置（仅收/发才前置，点击查看不前置）
        state.convTs[peerId] = Date.now();
        if (isGroup) renderGroups(); else renderFriends();
      })
      .catch(function (err) {
        toast(friendlyError(err));
        input.value = text;
      });
  });

  /* ---------- 发送文件 ---------- */
  $('pick-image').onclick = function () { $('file-image').click(); };
  $('pick-video').onclick = function () { $('file-video').click(); };
  $('pick-file').onclick = function () { $('file-any').click(); };

  $('file-image').onchange = function () { handleFile(this, 'image'); };
  $('file-video').onchange = function () { handleFile(this, 'video'); };
  $('file-any').onchange = function () { handleFile(this, 'file'); };

  function handleFile(inputEl, kind) {
    var file = inputEl.files && inputEl.files[0];
    inputEl.value = '';
    if (!file || !state.active) return;

    var maxMb = kind === 'image' ? (CFG.MAX_IMAGE_MB || 5)
              : kind === 'video' ? (CFG.MAX_VIDEO_MB || 50)
              : (CFG.MAX_FILE_MB || 20);
    if (file.size > maxMb * 1024 * 1024) {
      toast('文件超过 ' + maxMb + ' MB 上限（当前 ' + fmtSize(file.size) + '）');
      return;
    }

    var bar = $('upload-bar');
    bar.hidden = false;
    $('upload-text').textContent = '上传中… ' + file.name + ' (' + fmtSize(file.size) + ')';

    var ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    var rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
             : Date.now() + '-' + Math.random().toString(36).slice(2);
    var path = state.uid + '/' + rand + (ext ? '.' + ext : '');
    var target = state.active;

    sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
      .then(function (r) {
        if (r.error) throw r.error;
        var fpayload = {
          sender_id: state.uid,
          kind: kind,
          file_path: path,
          file_name: file.name,
          file_size: file.size
        };
        if (state.active.type === 'group') fpayload.group_id = target.id;
        else fpayload.receiver_id = target.id;
        return sb.from('messages').insert(fpayload).select().single();
      })
      .then(function (r) {
        if (r.error) throw r.error;
        if (state.active && state.active.id === target.id) appendMessage(r.data);
        else toast('已发送');
        // 发送文件也会把该会话前置（仅收/发才前置，点击查看不前置）
        state.convTs[target.id] = Date.now();
        if (target.type === 'group') renderGroups(); else renderFriends();
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { bar.hidden = true; });
  }

  /* ============================================================
   *  实时推送
   * ============================================================ */
  function subscribeRealtime() {
    if (state.channel) sb.removeChannel(state.channel);

    state.channel = sb.channel('chat-' + state.uid)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'messages'
      }, function (payload) {
        if (payload.eventType === 'DELETE') return;
        var m = payload.new;
        if (!m) return;

        var box = $('messages');
        var existing = box.querySelector('[data-id="' + m.id + '"]');

        // 自己发出的消息：本地已处理，这里只同步「更新」（撤回 / 本端删除）的回显，避免重复追加
        if (m.sender_id === state.uid) {
          if (existing) existing.replaceWith(renderMessage(m));
          return;
        }

        // 他人消息：若已显示则原地更新（对方撤回、或我本端删除的回显）；否则作为新消息处理
        if (existing) {
          existing.replaceWith(renderMessage(m));
          return;
        }

        if (m.group_id) {
          if (state.active && state.active.type === 'group' && state.active.id === m.group_id) {
            appendMessage(m);
          } else {
            state.unread[m.group_id] = (state.unread[m.group_id] || 0) + 1;
            state.convTs[m.group_id] = Date.now();
            renderGroups();
            var g = groupById(m.group_id);
            if (g) toast(g.name + ' 发来一条消息');
          }
        } else if (m.receiver_id === state.uid) {
          if (state.active && state.active.type !== 'group' && state.active.id === m.sender_id) {
            appendMessage(m);
          } else {
            state.unread[m.sender_id] = (state.unread[m.sender_id] || 0) + 1;
            state.convTs[m.sender_id] = Date.now();
            renderFriends();
            var from = friendById(m.sender_id);
            if (from) toast(from.nickname + ' 发来一条消息');
          }
        }
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'friendships'
      }, function () { loadRelations(); })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'groups'
      }, function () { loadGroups(); })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'group_members'
      }, function () { loadGroups(); })
      .subscribe();
  }

  /* 页面重新可见时补拉一次，避免长时间挂起丢消息 */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.uid) {
      loadRelations();
      if (state.active) openChat(state.active);
    }
  });
})();
