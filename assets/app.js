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
    groups: [],         // { id, name, ownerId, memberIds, memberCount, iAmOwner }
    profilesById: {},   // uid -> { nickname, avatar_path, phone }
    active: null,       // 当前会话：好友对象或群组对象（type==='group'）
    unread: {},         // { peerId: number }  未读消息计数（好友或群）
    recallTimer: null,  // 定时刷新“撤回/删除”按钮的定时器
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
      .then(loadGroups)
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
              iAmRequester: iAmRequester,
              type: 'friend'
            });
          } else if (row.status === 'pending' && !iAmRequester) {
            incoming.push({ rowId: row.id, user: other });
          }
        });
        state.friends = friends;
        state.incoming = incoming;
        friends.forEach(function (f) {
          state.profilesById[f.id] = { nickname: f.nickname, avatar_path: f.avatar, phone: f.phone };
        });
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

  function makeResultRow(user) {
    var row = el('div', 'row');
    var av = el('div', 'avatar sm');
    var remark = user.remark || '';
    setAvatar(av, { nickname: remark || user.nickname, phone: user.phone, avatarPath: user.avatar_path });
    var info = el('div', 'info');
    info.appendChild(el('div', 'nm', remark || user.nickname));
    info.appendChild(el('div', 'ph', user.phone + (remark ? ' · ' + user.nickname : '')));
    row.appendChild(av); row.appendChild(info);
    return row;
  }

  function onUnifiedSearch() {
    var kw = $('search-box').value.trim();
    var panel = $('search-result');
    var list = $('friend-list');
    if (!kw) {
      panel.hidden = true; panel.innerHTML = '';
      list.hidden = false;
      $('friend-empty').hidden = state.friends.length > 0;
      return;
    }
    list.hidden = true;
    $('friend-empty').hidden = true;
    panel.hidden = false; panel.innerHTML = '';

    var q = kw.toLowerCase();
    var local = state.friends.filter(function (f) {
      var hay = [f.phone, f.nickname, f.remark, (f.remark ? f.nickname : '')]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    local.forEach(function (f) {
      var row = makeResultRow(f);
      row.classList.add('clickable');
      row.onclick = function () {
        $('search-box').value = '';
        onUnifiedSearch();
        openChat(f);
      };
      panel.appendChild(row);
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
          $('peer-name').textContent = f.remark || f.nickname;
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
    $('del-friend-modal').hidden = false;
  }

  function closeDelFriend() {
    $('del-friend-modal').hidden = true;
    pendingDelFriend = null;
  }

  function confirmDelFriend() {
    var f = pendingDelFriend;
    if (!f) return;
    $('del-friend-modal').hidden = true;
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
      .select('id,name,owner_id, group_members(user_id)')
      .order('created_at', { ascending: false })
      .then(function (r) {
        if (r.error) throw r.error;
        state.groups = (r.data || []).map(function (g) {
          var members = (g.group_members || []).map(function (m) { return m.user_id; });
          return {
            type: 'group',
            id: g.id,
            name: g.name,
            ownerId: g.owner_id,
            memberIds: members,
            memberCount: members.length,
            iAmOwner: g.owner_id === state.uid
          };
        });
        if (state.active && state.active.type === 'group') {
          var fresh = groupById(state.active.id);
          if (fresh) state.active = fresh;
        }
        renderGroups();
        return state.groups;
      });
  }

  function renderGroups() {
    var list = $('group-list');
    if (!list) return;
    list.innerHTML = '';
    $('group-empty').hidden = state.groups.length > 0;
    state.groups.forEach(function (g) {
      var li = el('li');
      if (state.active && state.active.type === 'group' && state.active.id === g.id) li.classList.add('is-active');
      var av = el('div', 'avatar sm');
      av.textContent = g.name ? g.name.charAt(0) : '群';
      av.style.background = '#7f77dd';
      var info = el('div', 'info');
      info.appendChild(el('div', 'nm', g.name));
      info.appendChild(el('div', 'ph', g.memberCount + ' 位成员'));
      li.appendChild(av); li.appendChild(info);
      var cnt = state.unread[g.id] || 0;
      if (cnt > 0) {
        var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
        li.appendChild(badge);
      }
      li.onclick = function () { var gg = groupById(g.id); if (gg) openChat(gg); };
      list.appendChild(li);
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
    $('new-group-modal').hidden = false;
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
    sb.from('groups').insert({ name: name, owner_id: state.uid }).select().single()
      .then(function (r) {
        if (r.error) throw r.error;
        var gid = r.data.id;
        var members = [state.uid].concat(memberIds).map(function (uid) { return { group_id: gid, user_id: uid }; });
        return sb.from('group_members').insert(members).then(function (r2) {
          if (r2.error) throw r2.error;
          return gid;
        });
      })
      .then(function (gid) {
        $('new-group-modal').hidden = true;
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
    renderMemberList(g);
    $('group-info-modal').hidden = false;
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
    sb.from('group_members').delete().eq('group_id', g.id).eq('user_id', uid)
      .then(function (r) { if (r.error) throw r.error; toast('已移除成员'); return loadGroups(); })
      .then(function () {
        var ng = groupById(g.id);
        if (ng) { state.active = ng; renderMemberList(ng); renderGroups(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function transferOwner(g, uid) {
    sb.from('groups').update({ owner_id: uid }).eq('id', g.id)
      .then(function (r) { if (r.error) throw r.error; toast('已转让群主'); return loadGroups(); })
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
    sb.from('group_members').delete().eq('group_id', g.id).eq('user_id', state.uid)
      .then(function (r) { if (r.error) throw r.error; toast('已退出群聊'); $('group-info-modal').hidden = true; return loadGroups(); })
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
  $('new-group-close').addEventListener('click', function () { $('new-group-modal').hidden = true; });
  $('new-group-cancel').addEventListener('click', function () { $('new-group-modal').hidden = true; });
  $('new-group-modal').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });

  $('group-info-btn').addEventListener('click', openGroupInfo);
  $('group-info-close').addEventListener('click', function () { $('group-info-modal').hidden = true; });
  $('group-info-modal').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
  $('group-info-save').addEventListener('click', function () {
    if (!state.active || !state.active.iAmOwner) return;
    var name = $('group-info-name').value.trim();
    if (!name) { toast('群名称不能为空'); return; }
    sb.from('groups').update({ name: name }).eq('id', state.active.id)
      .then(function (r) { if (r.error) throw r.error; toast('已保存'); return loadGroups(); })
      .then(function () {
        var ng = groupById(state.active.id);
        if (ng) { $('peer-name').textContent = ng.name; openGroupInfo(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  });
  $('group-info-leave').addEventListener('click', leaveGroup);

  $('group-info-add').addEventListener('click', function () {
    if (!state.active) return;
    var g = state.active;
    var candidates = state.friends.filter(function (f) { return g.memberIds.indexOf(f.id) < 0; });
    renderFriendPicker($('add-member-picker'), candidates, []);
    $('add-member-modal').hidden = false;
  });
  $('add-member-confirm').addEventListener('click', function () {
    if (!state.active) return;
    var g = state.active;
    var checks = $('add-member-picker').querySelectorAll('input[type=checkbox]:checked');
    if (!checks.length) { toast('请选择要添加的好友'); return; }
    var ids = []; checks.forEach(function (c) { ids.push(c.value); });
    var members = ids.map(function (uid) { return { group_id: g.id, user_id: uid }; });
    sb.from('group_members').insert(members)
      .then(function (r) { if (r.error) throw r.error; toast('已添加成员'); $('add-member-modal').hidden = true; return loadGroups(); })
      .then(function () {
        var ng = groupById(g.id);
        if (ng) { state.active = ng; renderMemberList(ng); renderGroups(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  });
  $('add-member-close').addEventListener('click', function () { $('add-member-modal').hidden = true; });
  $('add-member-cancel').addEventListener('click', function () { $('add-member-modal').hidden = true; });
  $('add-member-modal').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });

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
    if (isGroup) renderGroups(); else renderFriends();

    $('chat-empty').hidden = true;
    $('chat-room').hidden = false;
    document.querySelector('.app-view').classList.add('show-chat');

    $('peer-name').textContent = isGroup ? peer.name : (peer.remark || peer.nickname);
    $('peer-phone').textContent = isGroup ? (peer.memberCount + ' 位成员') : peer.phone;

    var av = $('peer-avatar');
    if (isGroup) {
      av.textContent = peer.name ? peer.name.charAt(0) : '群';
      av.style.background = '#7f77dd';
      var oldImg = av.querySelector('img'); if (oldImg) oldImg.remove();
    } else {
      setAvatar(av, { nickname: peer.remark || peer.nickname, phone: peer.phone, avatarPath: peer.avatar });
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

    var payload = {
      sender_id: state.uid,
      kind: 'text',
      content: text
    };
    if (state.active.type === 'group') payload.group_id = state.active.id;
    else payload.receiver_id = state.active.id;

    sb.from('messages').insert(payload).select().single()
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
            renderGroups();
            var g = groupById(m.group_id);
            if (g) toast(g.name + ' 发来一条消息');
          }
        } else if (m.receiver_id === state.uid) {
          if (state.active && state.active.type !== 'group' && state.active.id === m.sender_id) {
            appendMessage(m);
          } else {
            state.unread[m.sender_id] = (state.unread[m.sender_id] || 0) + 1;
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
