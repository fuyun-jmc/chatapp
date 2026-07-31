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
    active: null,       // 当前会话好友
    unread: {},         // { friendId: number }  未读消息计数
    urlCache: {},       // file_path -> signed url
    channel: null
  };

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
      })
      .catch(function (e) { showErr('login-error', friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '登录'; });
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
      })
      .catch(function (e) { showErr('reg-error', friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '注册并登录'; });
  });

  $('logout-btn').addEventListener('click', function () {
    sb.auth.signOut();
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
    if (r.data && r.data.session) {
      state.uid = r.data.session.user.id;
      start(r.data.session);
    } else {
      $('auth-view').hidden = false;
    }
  });

  function teardown() {
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
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

    loadProfile()
      .then(loadRelations)
      .then(subscribeRealtime)
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
            friends.push({
              id: other.id,
              phone: other.phone,
              nickname: other.nickname,
              avatar: other.avatar_path,
              remark: myRemark,
              relId: row.id,
              iAmRequester: iAmRequester
            });
          } else if (row.status === 'pending' && !iAmRequester) {
            incoming.push({ rowId: row.id, user: other });
          }
        });
        state.friends = friends;
        state.incoming = incoming;
        renderFriends();
        renderRequests();

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

  function renderFriends() {
    var list = $('friend-list');
    list.innerHTML = '';
    $('friend-empty').hidden = state.friends.length > 0;

    state.friends.forEach(function (f) {
      var li = el('li');
      if (state.active && state.active.id === f.id) li.classList.add('is-active');
      var av = el('div', 'avatar sm');
      setAvatar(av, { nickname: f.remark || f.nickname, phone: f.phone, avatarPath: f.avatar });
      var info = el('div', 'info');
      info.appendChild(el('div', 'nm', f.remark || f.nickname));
      info.appendChild(el('div', 'ph', f.phone + (f.remark ? ' · ' + f.nickname : '')));
      li.appendChild(av); li.appendChild(info);

      var rem = el('button', 'remark-btn', '备注');
      rem.type = 'button';
      rem.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); editRemark(f); };
      li.appendChild(rem);

      var cnt = parseInt(state.unread[f.id] || 0, 10) || 0;
      if (cnt > 0) {
        var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
        badge.setAttribute('aria-label', '未读消息 ' + cnt + ' 条');
        li.appendChild(badge);
      }
      li.onclick = function () { openChat(f); };
      list.appendChild(li);
    });
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
          $('peer-name').textContent = f.remark || f.nickname;
          $('peer-avatar').textContent = initialOf(f.remark || f.nickname);
        }
        toast(val ? '已设置备注：' + val : '已清除备注');
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

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
    $('settings-modal').hidden = false;
  }

  function closeSettings() {
    $('settings-modal').hidden = true;
    pendingAvatar = null;
  }

  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-modal').addEventListener('click', function (e) {
    if (e.target === this) closeSettings();
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

  /* ---------- 按手机号搜索并添加 ---------- */
  $('search-btn').addEventListener('click', doSearch);
  $('search-phone').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });

  function doSearch() {
    var phone = $('search-phone').value.trim();
    var box = $('search-result');
    if (!PHONE_RE.test(phone)) { toast('请输入正确的 11 位手机号'); return; }
    if (phone === state.profile.phone) { toast('这是你自己的手机号'); return; }

    var btn = $('search-btn');
    btn.disabled = true;
    sb.from('profiles').select('id,phone,nickname,avatar_path').eq('phone', phone).maybeSingle()
      .then(function (r) {
        if (r.error) throw r.error;
        box.hidden = false;
        box.innerHTML = '';
        if (!r.data) {
          box.appendChild(el('div', 'note', '没有找到该手机号的用户，可能还没注册。'));
          return null;
        }
        var user = r.data;
        var row = el('div', 'row');
        var av = el('div', 'avatar sm');
        setAvatar(av, { nickname: user.nickname, phone: user.phone, avatarPath: user.avatar_path });
        var info = el('div', 'info');
        info.appendChild(el('div', 'nm', user.nickname));
        info.appendChild(el('div', 'ph', user.phone));
        row.appendChild(av); row.appendChild(info);
        box.appendChild(row);

        var already = state.friends.some(function (f) { return f.id === user.id; });
        if (already) {
          box.appendChild(el('div', 'note', '已经是好友了'));
          return null;
        }
        var add = el('button', 'btn-mini', '加为好友');
        add.style.padding = '6px 12px';
        add.onclick = function () { sendRequest(user, add); };
        row.appendChild(add);
        return null;
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; });
  }

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
  function openChat(friend) {
    state.active = friend;
    delete state.unread[friend.id];
    renderFriends();

    $('chat-empty').hidden = true;
    $('chat-room').hidden = false;
    document.querySelector('.app-view').classList.add('show-chat');

    $('peer-name').textContent = friend.remark || friend.nickname;
    $('peer-phone').textContent = friend.phone;
    var av = $('peer-avatar');
    setAvatar(av, { nickname: friend.remark || friend.nickname, phone: friend.phone, avatarPath: friend.avatar });

    var box = $('messages');
    box.innerHTML = '';
    box.appendChild(el('div', 'day-sep', '加载中…'));

    sb.from('messages').select('*')
      .or('and(sender_id.eq.' + state.uid + ',receiver_id.eq.' + friend.id + '),' +
          'and(sender_id.eq.' + friend.id + ',receiver_id.eq.' + state.uid + ')')
      .order('created_at', { ascending: false })
      .limit(LIMIT)
      .then(function (r) {
        if (r.error) throw r.error;
        if (!state.active || state.active.id !== friend.id) return;
        box.innerHTML = '';
        var rows = (r.data || []).slice().reverse();
        if (!rows.length) {
          box.appendChild(el('div', 'day-sep', '还没有消息，打个招呼吧'));
        }
        var lastDay = null;
        rows.forEach(function (m) {
          var k = dayKey(m.created_at);
          if (k !== lastDay) { box.appendChild(el('div', 'day-sep', dayLabel(m.created_at))); lastDay = k; }
          box.appendChild(renderMessage(m));
        });
        scrollBottom();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  $('back-btn').addEventListener('click', function () {
    document.querySelector('.app-view').classList.remove('show-chat');
  });

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

  function renderMessage(m) {
    var out = m.sender_id === state.uid;
    var wrap = el('div', 'msg ' + (out ? 'out' : 'in'));
    wrap.dataset.id = m.id;

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
          $('lightbox-img').src = u;
          $('lightbox').hidden = false;
        };
      });
    } else if (m.kind === 'video') {
      bubble = el('div', 'bubble media');
      var vid = document.createElement('video');
      vid.controls = true;
      vid.preload = 'metadata';
      vid.playsInline = true;
      bubble.appendChild(vid);
      signedUrl(m.file_path).then(function (u) { if (u) vid.src = u; });
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

    wrap.appendChild(bubble);
    wrap.appendChild(el('div', 'msg-time', fmtTime(m.created_at)));

    if (out) {
      var rb = el('button', 'recall-btn', '撤回');
      rb.type = 'button';
      rb.onclick = function () { recallMessage(m.id); };
      wrap.appendChild(rb);
    }
    return wrap;
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

  $('lightbox').addEventListener('click', function () { this.hidden = true; });

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

    sb.from('messages').insert({
      sender_id: state.uid,
      receiver_id: state.active.id,
      kind: 'text',
      content: text
    }).select().single()
      .then(function (r) {
        if (r.error) throw r.error;
        appendMessage(r.data);
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
        return sb.from('messages').insert({
          sender_id: state.uid,
          receiver_id: target.id,
          kind: kind,
          file_path: path,
          file_name: file.name,
          file_size: file.size
        }).select().single();
      })
      .then(function (r) {
        if (r.error) throw r.error;
        if (state.active && state.active.id === target.id) appendMessage(r.data);
        else toast('已发送');
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
        event: '*', schema: 'public', table: 'messages',
        filter: 'receiver_id=eq.' + state.uid
      }, function (payload) {
        if (payload.eventType === 'DELETE') return;
        var m = payload.new;
        if (!m) return;
        if (state.active && m.sender_id === state.active.id) {
          if (payload.eventType === 'UPDATE' || m.recalled) {
            var old = $('messages').querySelector('[data-id="' + m.id + '"]');
            if (old) old.replaceWith(renderMessage(m));
          } else {
            appendMessage(m);
          }
        } else if (!m.recalled) {
          state.unread[m.sender_id] = (state.unread[m.sender_id] || 0) + 1;
          renderFriends();
          var from = state.friends.filter(function (f) { return f.id === m.sender_id; })[0];
          if (from) toast(from.nickname + ' 发来一条消息');
        }
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'friendships'
      }, function () {
        loadRelations();
      })
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
