(function () {
  "use strict";

  // 登录态失效（返回 401）时统一跳转登录页
  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    return _origFetch.apply(this, args).then((r) => {
      if (r.status === 401 && !location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
      return r;
    });
  };

  const App = window.APP || {};
  const state = {
    path: "",
    view: "list",
    items: [],
    selected: new Set(),
    clipboard: null, // {op:'copy'|'move', items:[{path,name,is_dir}]}
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const enc = (p) => encodeURIComponent(p);

  // ---------- API ----------
  async function api(url, opts) {
    const r = await fetch(url, opts);
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || ("HTTP " + r.status));
    }
    return data;
  }
  const post = (url, body) =>
    api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // ---------- 工具 ----------
  function iconClass(ext, isDir) {
    if (isDir) return { cls: "badge-folder", label: "📁" };
    const e = (ext || "").toLowerCase();
    if (["php"].includes(e)) return { cls: "ico-php", label: "PHP" };
    if (["html", "htm"].includes(e)) return { cls: "ico-html", label: "H" };
    if (["css"].includes(e)) return { cls: "ico-css", label: "#" };
    if (["js", "ts", "jsx", "vue"].includes(e)) return { cls: "ico-js", label: "JS" };
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(e)) return { cls: "ico-img", label: "🖼" };
    if (["txt", "md", "log", "ini", "cfg", "conf", "json", "xml", "yml", "yaml", "csv", "env", "gitignore", "htaccess"].includes(e)) return { cls: "ico-default", label: "T" };
    return { cls: "ico-default", label: (e || "?").slice(0, 4).toUpperCase() };
  }

  function toast(msg, type) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast " + (type || "");
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2600);
  }
  // 复制到剪贴板：优先现代 clipboard API（需 secure context）；
  // 非 secure context（http://IP:port 等）浏览器拒绝，降到 textarea+execCommand("copy") 兼容。
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) { /* 降级 */ }
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }
  function setStatus(s) { $("#statusbar").textContent = s; }

  // ---------- 列表渲染 ----------
  async function loadList(path) {
    if (path !== undefined) state.path = path;
    try {
      const data = await api("/api/list?path=" + enc(state.path));
      state.items = data.items;
      state.selected.clear();
      renderCrumbs(data.parent);
      renderList();
      renderGrid();
      updateSelectionUI();
      setStatus(`共 ${data.items.length} 项 · ${state.path || "根目录"}`);
    } catch (e) {
      toast("加载失败：" + e.message, "err");
    }
  }

  // ---------- 目录树 ----------
  const treeExpanded = new Set([""]); // 已展开的目录路径（含根）
  async function loadTree() {
    try {
      const d = await api("/api/tree");
      state.tree = d.tree;
      renderTree();
    } catch (e) { /* 忽略树加载错误 */ }
  }
  function renderTreeNode(node) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node";
    const hasChildren = node.children && node.children.length > 0;
    const row = document.createElement("div");
    row.className = "tree-row" + (state.path === node.path ? " active" : "");
    const arrow = document.createElement("span");
    arrow.className = "tw-arrow" + (hasChildren ? "" : " leaf") + (treeExpanded.has(node.path) ? " open" : "");
    arrow.textContent = "▶";
    const ico = document.createElement("span");
    ico.className = "tw-ico"; ico.textContent = "📁";
    const name = document.createElement("span");
    name.className = "tw-name"; name.textContent = node.name;
    row.append(arrow, ico, name);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      // 展开父链，确保当前节点可见
      let acc = "";
      node.path.split("/").forEach((s) => { acc = acc ? acc + "/" + s : s; treeExpanded.add(acc); });
      state.path = node.path;
      loadList(node.path);
      renderTree();
    });
    wrap.appendChild(row);
    if (hasChildren) {
      const box = document.createElement("div");
      box.className = "tree-children";
      if (!treeExpanded.has(node.path)) box.hidden = true;
      node.children.forEach((ch) => box.appendChild(renderTreeNode(ch)));
      wrap.appendChild(box);
    }
    return wrap;
  }
  function renderTree() {
    const t = $("#tree");
    t.innerHTML = "";
    const rootRow = mk("div", "tree-row" + (state.path === "" ? " active" : ""), "", () => {
      treeExpanded.add(""); state.path = ""; loadList(""); renderTree();
    });
    rootRow.innerHTML = '<span class="tw-arrow leaf">▶</span><span class="tw-ico">🗂</span><span class="tw-name">根目录</span>';
    t.appendChild(rootRow);
    if (state.tree) state.tree.forEach((n) => t.appendChild(renderTreeNode(n)));
  }

  // ---------- 重启服务（仿宝塔） ----------
  async function restartServer() {
    if (!confirm("确定重启文件管理器服务？重启期间连接会短暂中断。")) return;
    toast("正在重启服务…", "ok");
    try { await post("/api/restart", {}); } catch (e) { /* execv 后连接断开，属正常 */ }
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      try {
        const r = await fetch("/api/info");
        if (r.ok) {
          clearInterval(timer);
          toast("服务已重启", "ok");
          loadTree(); loadList(state.path);
          return;
        }
      } catch (e) {}
      if (tries > 40) { clearInterval(timer); toast("重启超时，请检查服务", "err"); }
    }, 1000);
  }

  function renderCrumbs() {
    const c = $("#crumbs");
    c.innerHTML = "";
    const segs = state.path ? state.path.split("/") : [];
    const root = mk("span", "seg root", "🗂 根目录", () => loadList(""));
    c.appendChild(root);
    let acc = "";
    segs.forEach((s) => {
      c.appendChild(mk("span", "sep", "/"));
      acc = acc ? acc + "/" + s : s;
      const cur = acc;
      c.appendChild(mk("span", "seg", s, () => loadList(cur)));
    });
  }
  function mk(tag, cls, text, onClick) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (onClick) el.onclick = (ev) => { ev.stopPropagation(); onClick(); };
    return el;
  }

  function renderList() {
    const body = $("#fileBody");
    body.innerHTML = "";
    $("#emptyHint").hidden = state.items.length > 0;
    $("#filelist").hidden = state.view !== "list";
    $("#gridView").hidden = state.view !== "grid";
    state.items.forEach((it) => {
      const tr = document.createElement("tr");
      tr.dataset.path = it.path;
      const ico = iconClass(it.ext, it.is_dir);
      tr.innerHTML =
        `<td class="col-check"><input type="checkbox" class="rowchk"></td>` +
        `<td><div class="name-cell"><span class="badge-ico ${ico.cls}">${ico.label}</span>` +
        `<span class="fname">${escapeHtml(it.name)}</span>` +
        (it.editable ? `<span class="fext">可编辑</span>` : ``) + `</div></td>` +
        `<td class="col-size">${it.size_text || "—"}</td>` +
        `<td class="col-time">${it.mtime}</td>`;
      tr.addEventListener("click", (e) => onRowClick(e, it, tr));
      tr.addEventListener("dblclick", () => openItem(it));
      tr.addEventListener("contextmenu", (e) => onCtx(e, it));
      body.appendChild(tr);
    });
  }

  function renderGrid() {
    const g = $("#gridView");
    g.innerHTML = "";
    state.items.forEach((it) => {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.path = it.path;
      const ico = iconClass(it.ext, it.is_dir);
      const big = it.is_dir ? "📁" : /img/.test(ico.cls) ? "🖼" : "📄";
      card.innerHTML =
        `<div class="gcheck"><input type="checkbox" class="rowchk"></div>` +
        `<div class="big-ico">${big}</div>` +
        `<div class="gname">${escapeHtml(it.name)}</div>`;
      card.addEventListener("click", (e) => onRowClick(e, it, card));
      card.addEventListener("dblclick", () => openItem(it));
      card.addEventListener("contextmenu", (e) => onCtx(e, it));
      g.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- 选择 ----------
  function onRowClick(e, it, el) {
    const chk = e.target.classList.contains("rowchk");
    if (e.target.tagName === "INPUT") return; // 复选框自己处理
    if (e.ctrlKey || e.metaKey) {
      toggleSel(it.path);
    } else if (e.shiftKey && lastPath) {
      shiftSelect(it.path);
    } else {
      state.selected.clear();
      state.selected.add(it.path);
      lastPath = it.path;
    }
    updateSelectionUI();
  }
  let lastPath = null;
  function shiftSelect(path) {
    const paths = state.items.map((i) => i.path);
    const a = paths.indexOf(lastPath), b = paths.indexOf(path);
    if (a < 0 || b < 0) { state.selected.add(path); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) state.selected.add(paths[i]);
  }
  function toggleSel(path) {
    if (state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
  }
  function updateSelectionUI() {
    $$(".rowchk").forEach((chk) => {
      const row = chk.closest("[data-path]");
      const p = row && row.dataset.path;
      chk.checked = state.selected.has(p);
      row.classList.toggle("sel", state.selected.has(p));
    });
    const n = state.selected.size;
    setStatus(n ? `已选择 ${n} 项` : `共 ${state.items.length} 项 · ${state.path || "根目录"}`);
  }

  // 复选框事件
  document.addEventListener("change", (e) => {
    if (e.target.classList.contains("rowchk")) {
      const row = e.target.closest("[data-path]");
      const p = row.dataset.path;
      if (e.target.checked) state.selected.add(p); else state.selected.delete(p);
      updateSelectionUI();
    }
  });
  $("#checkAll").addEventListener("change", (e) => {
    state.items.forEach((it) => {
      if (e.target.checked) state.selected.add(it.path); else state.selected.delete(it.path);
    });
    updateSelectionUI();
  });

  // ---------- 打开 ----------
  function openItem(it) {
    if (it.is_dir) loadList(it.path);
    else if (it.editable) openEditor(it);
    else downloadOne(it.path);
  }

  // ---------- 右键菜单（仿宝塔） ----------
  function onCtx(e, it) {
    e.preventDefault();
    const menu = $("#ctxmenu");
    menu.innerHTML = "";
    const sel = state.selected;
    if (!sel.has(it.path) && sel.size) { state.selected.clear(); state.selected.add(it.path); updateSelectionUI(); }
    else if (!sel.has(it.path)) { state.selected.clear(); state.selected.add(it.path); updateSelectionUI(); }
    const selItems = getSelItems();
    const targets = selItems.length ? selItems : [it];

    const items = [];
    // 组1：打开
    if (it.is_dir) items.push({ ico: "📂", t: "打开", f: () => openItem(it) });
    else items.push({ ico: "📝", t: "编辑", f: () => openEditor(it) }, { ico: "⬇", t: "下载", f: () => downloadOne(it.path) });
    if (!it.is_dir && /\.php$/i.test(it.name)) items.push({ ico: "▶", t: "运行", f: () => runItem(it) });
    items.push({ ico: "🪟", t: "在新窗口打开", f: () => openInNewWindow(it) });
    items.push({ ico: "⭐", t: "添加到收藏夹", f: () => addFavorite(it) });
    items.push({ divider: true });
    // 组2：分享 / 权限
    items.push({ ico: "🔗", t: "外链分享", f: () => doShare(it) });
    items.push({ ico: "🔐", t: "权限", f: () => doChmod(it) });
    items.push({ divider: true });
    // 组3：复制 / 剪切 / 重命名 / 删除
    items.push({ ico: "⧉", t: "复制", f: () => doCopy() });
    items.push({ ico: "✀", t: "剪切", f: () => doCut() });
    if (state.clipboard) items.push({ ico: "📋", t: "粘贴到此处", f: () => doPaste(it.is_dir ? it.path : state.path) });
    items.push({ ico: "✏", t: "重命名", f: () => doRename(it) });
    items.push({ ico: "🗑", t: "删除", danger: true, f: () => doDelete() });
    items.push({ divider: true });
    // 组4：解压 / 压缩 / 属性
    if (/\.zip$/i.test(it.name)) items.push({ ico: "📦", t: "解压", f: () => doUnzip(it) });
    items.push({ ico: "🗜", t: "创建压缩", f: () => doCreateZip(targets) });
    items.push({ ico: "ℹ", t: "属性", f: () => doAttrs(it) });

    items.forEach((m) => {
      if (m.divider) { const d = document.createElement("div"); d.className = "divider"; menu.appendChild(d); return; }
      const el = document.createElement("div");
      el.className = "item" + (m.danger ? " danger" : "");
      el.innerHTML = `<span class="mi-ico">${m.ico || ""}</span><span class="mi-t">${m.t}</span>`;
      el.onclick = (ev) => { ev.stopPropagation(); menu.hidden = true; m.f(); };
      menu.appendChild(el);
    });
    menu.hidden = false;
    menu.style.left = Math.min(e.clientX, innerWidth - 200) + "px";
    menu.style.top = Math.min(e.clientY, innerHeight - 360) + "px";
  }

  // ---------- 右键菜单新增操作 ----------
  function openInNewWindow(it) {
    window.open("/?path=" + encodeURIComponent(it.path), "_blank");
  }
  function addFavorite(it) {
    try {
      const favs = JSON.parse(localStorage.getItem("ps_favs") || "[]");
      if (!favs.includes(it.path)) { favs.push(it.path); localStorage.setItem("ps_favs", JSON.stringify(favs)); }
      toast("已加入收藏夹", "ok");
    } catch (e) { toast("收藏失败：" + e.message, "err"); }
  }
  async function doShare(it) {
    try {
      // 期限档位（秒）: 1天 / 7天 / 30天 / 永久
      const DURATIONS = [
        { label: "1 天",  v: 86400 },
        { label: "7 天",  v: 604800 },
        { label: "30 天", v: 2592000 },
        { label: "永久",  v: 0 },
      ];
      const durHtml = DURATIONS.map((d, i) =>
        `<label class="dur-chip${i === 1 ? " active" : ""}" data-v="${d.v}">${d.label}</label>`
      ).join("");
      openModal("外链分享", `
        <div class="kv">
          <div class="row"><span class="k">文件</span><span class="v">${escapeHtml(it.name)}</span></div>
          <div class="row"><span class="k">有效期</span><span class="v dur-row" id="durRow">${durHtml}</span></div>
        </div>
        <div class="hint">该直链无需登录即可访问。文本类文件（代码/配置/Markdown 等）将在浏览器内打开，二进制文件按附件下载。</div>
        <div id="shareResult" class="share-result" hidden></div>
      `, [
        { text: "生成分享链接", cls: "primary", onClick: async (close) => {
            const durEl = document.querySelector("#durRow .dur-chip.active");
            const expire = durEl ? parseInt(durEl.dataset.v, 10) || 0 : 604800;
            try {
              const d = await post("/api/share", { path: it.path, expire });
              const link = d.link;
              const expireText = d.expire > 0
                ? new Date(d.exp_ts * 1000).toLocaleString("zh-CN")
                : "永久有效";
              document.getElementById("shareResult").hidden = false;
              document.getElementById("shareResult").innerHTML = `
                <div class="kv">
                  <div class="row"><span class="k">直链</span><span class="v"><code id="shareLink">${escapeHtml(link)}</code></span></div>
                  <div class="row"><span class="k">到期</span><span class="v">${escapeHtml(expireText)}</span></div>
                </div>
              `;
              toast("已生成直链", "ok");
            } catch (e) {
              toast("生成失败：" + e.message, "err");
            }
          } },
        { text: "复制直链", onClick: () => {
            const linkEl = document.getElementById("shareLink");
            if (!linkEl) { toast("请先生成链接", "warn"); return; }
            const link = linkEl.textContent;
            copyText(link).then(ok => toast(ok ? "已复制直链" : "复制失败，请手动复制", ok ? "ok" : "err"));
          } },
        { text: "关闭", onClick: closeModal },
      ]);
      // 绑定期限 chip 切换（事件委托，单次）
      const row = document.getElementById("durRow");
      if (row && !row._bound) {
        row._bound = true;
        row.addEventListener("click", (ev) => {
          const chip = ev.target.closest(".dur-chip");
          if (!chip) return;
          row.querySelectorAll(".dur-chip").forEach(c => c.classList.remove("active"));
          chip.classList.add("active");
        });
      }
    } catch (e) { toast("分享失败：" + e.message, "err"); }
  }

  async function showShareList() {
    // 我的分享管理列表（支持复制 / 取消）
    try {
      const d = await api("/api/shares");
      const shares = d.shares || [];
      const baseUrl = window.location.origin;
      const rows = shares.length === 0
        ? `<div class="hint">暂无分享记录。右键文件 → 外链分享 可创建。</div>`
        : `<div class="share-list">${shares.map(s => {
            const expText = s.exp
              ? new Date(s.exp * 1000).toLocaleString("zh-CN")
              : "<span class=\"exp-perm\">永久</span>";
            const shortTok = s.token.length > 14 ? s.token.slice(0, 6) + "…" + s.token.slice(-4) : s.token;
            return `
              <div class="share-row" data-token="${escapeHtml(s.token)}">
                <div class="share-name" title="${escapeHtml(s.path)}">${escapeHtml(s.name)}</div>
                <div class="share-meta">${expText}</div>
                <div class="share-actions">
                  <button class="btn sm act-copy" data-link="${escapeHtml(s.link)}">复制</button>
                  <button class="btn sm danger act-revoke">取消</button>
                </div>
              </div>`;
          }).join("")}</div>`;
      openModal("我的分享", rows, [
        { text: "刷新", onClick: () => { closeModal(); showShareList(); } },
        { text: "关闭", onClick: closeModal },
      ]);
      // 事件绑定（复制 / 取消）
      const root = document.querySelector(".share-list");
      if (root) {
        root.addEventListener("click", async (ev) => {
          const copyBtn = ev.target.closest(".act-copy");
          if (copyBtn) {
            const link = copyBtn.dataset.link;
            const ok = await copyText(link);
            toast(ok ? "已复制" : "复制失败，请手动复制", ok ? "ok" : "err");
            return;
          }
          const revBtn = ev.target.closest(".act-revoke");
          if (revBtn) {
            const row = revBtn.closest(".share-row");
            const token = row.dataset.token;
            if (!confirm("确定取消这条分享？取消后直链将立即失效。")) return;
            try {
              const r = await post("/api/unshare", { token });
              if (r.existed) toast("已取消分享", "ok");
              else toast("直链已不存在", "warn");
              // 移除该行
              row.remove();
              if (!document.querySelector(".share-row")) {
                document.querySelector(".share-list")?.remove();
                const hint = document.createElement("div");
                hint.className = "hint";
                hint.textContent = "暂无分享记录。";
                document.querySelector("#modalBody, .modal-body")?.appendChild(hint);
              }
            } catch (e) {
              toast("取消失败：" + e.message, "err");
            }
          }
        });
      }
    } catch (e) { toast("加载分享列表失败：" + e.message, "err"); }
  }
  async function doAttrs(it) {
    try {
      const d = await api("/api/attrs?path=" + enc(it.path));
      const i = d.info;
      const rows = [
        ["名称", i.name], ["类型", i.is_dir ? "目录" : "文件"], ["大小", i.size_text],
        ["权限", i.mode + (i.readonly ? "（只读）" : "")],
        ["修改时间", i.mtime_text], ["创建时间", i.ctime_text],
      ];
      if (i.is_dir) { rows.push(["包含文件", i.file_count]); rows.push(["包含目录", i.dir_count]); }
      openModal("属性 · " + i.name,
        `<div class="kv">${rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join("")}</div>`,
        [{ text: "关闭", onClick: closeModal }]);
    } catch (e) { toast("获取属性失败：" + e.message, "err"); }
  }
  function doChmod(it) {
    promptModal("权限", "输入 Unix 权限（3 位八进制，如 755 / 644）", "755", async (mode, errEl) => {
      if (!/^[0-7]{3}$/.test(mode)) { errEl.textContent = "权限需为 3 位八进制（0–7）"; errEl.hidden = false; return; }
      try {
        const d = await post("/api/chmod", { path: it.path, mode });
        closeModal(); toast("权限已设为 " + d.mode, "ok"); loadList();
      } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
    });
  }
  function doCreateZip(items) {
    const def = (items.length === 1 ? items[0].name : "archive") + ".zip";
    promptModal("创建压缩", "压缩包名称（保存到当前目录）", def, async (name, errEl) => {
      if (!name) { errEl.textContent = "名称不能为空"; errEl.hidden = false; return; }
      try {
        const d = await post("/api/zip", { paths: items.map((i) => i.path), name });
        closeModal(); loadList(); toast("已创建 " + d.name, "ok");
      } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
    });
  }
  async function doUnzip(it) {
    try {
      const d = await post("/api/unzip", { path: it.path });
      loadList();
      toast("已解压到 " + d.name, "ok");
    } catch (e) { toast("解压失败：" + e.message, "err"); }
  }
  document.addEventListener("click", () => { $("#ctxmenu").hidden = true; });
  $("#filearea").addEventListener("contextmenu", (e) => {
    if (e.target.closest("[data-path]")) return;
    e.preventDefault();
    const menu = $("#ctxmenu");
    menu.innerHTML = "";
    [["＋ 新建文件", () => doCreate("file")], ["＋ 新建文件夹", () => doCreate("dir")],
     ["⬆ 上传", () => triggerUpload()], ["⟳ 刷新", () => loadList()]
    ].forEach(([t, f]) => menu.appendChild(mk("div", "item", t, f)));
    menu.hidden = false;
    menu.style.left = Math.min(e.clientX, innerWidth - 180) + "px";
    menu.style.top = Math.min(e.clientY, innerHeight - 200) + "px";
  });

  // ---------- 弹窗 ----------
  function openModal(title, bodyHtml, footBtns, cardClass) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    const card = $("#modal").querySelector(".modal-card");
    card.className = "modal-card" + (cardClass ? " " + cardClass : "");
    const foot = $("#modalFoot");
    foot.innerHTML = "";
    (footBtns || []).forEach((b) => {
      const el = document.createElement("button");
      el.className = "btn " + (b.cls || "ghost");
      el.textContent = b.text;
      el.onclick = b.onClick;
      foot.appendChild(el);
    });
    $("#modal").hidden = false;
  }
  function closeModal() { $("#modal").hidden = true; }

  function promptModal(title, placeholder, def, onOk, typeLabel) {
    openModal(title,
      `<input id="mInput" placeholder="${placeholder}" value="${def || ""}">` +
      `<div class="msg-error" id="mErr" hidden></div>`,
      [
        { text: "取消", onClick: closeModal },
        { text: "确定", cls: "primary", onClick: () => onOk($("#mInput").value, $("#mErr")) },
      ]);
    setTimeout(() => { const i = $("#mInput"); i.focus(); i.select(); }, 30);
  }

  // ---------- 操作 ----------
  function getSelItems() {
    return state.items.filter((i) => state.selected.has(i.path));
  }

  function doCreate(type) {
    promptModal(type === "dir" ? "新建文件夹" : "新建文件", "输入名称…", "",
      async (name, errEl) => {
        if (!name) { errEl.textContent = "名称不能为空"; errEl.hidden = false; return; }
        try {
          await post("/api/create", { path: state.path, name, type: type === "dir" ? "dir" : "file" });
          closeModal(); toast("已创建", "ok"); loadList();
        } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
      });
  }

  function doRename(it) {
    const item = it || getSelItems()[0];
    if (!item) return;
    promptModal("重命名", "新名称", item.name, async (name, errEl) => {
      if (!name) { errEl.textContent = "名称不能为空"; errEl.hidden = false; return; }
      try {
        await post("/api/rename", { path: item.path, new_name: name });
        closeModal(); toast("已重命名", "ok"); loadList();
      } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
    });
  }

  function doDelete() {
    const items = getSelItems();
    if (!items.length) return;
    const names = items.map((i) => i.name).join("、");
    openModal("确认删除", `<p>确定删除以下 ${items.length} 项吗？此操作不可恢复。</p><p class="hint">${escapeHtml(names)}</p>`,
      [
        { text: "取消", onClick: closeModal },
        { text: "删除", cls: "danger", onClick: async () => {
            try {
              await post("/api/delete", { paths: items.map((i) => i.path) });
              closeModal(); toast("已删除", "ok"); loadList();
            } catch (e) { toast("删除失败：" + e.message, "err"); closeModal(); }
          } },
      ]);
  }

  function doCopy() {
    const items = getSelItems();
    if (!items.length) return;
    state.clipboard = { op: "copy", items };
    toast(`已复制 ${items.length} 项`, "ok"); updateSelectionUI();
  }
  function doCut() {
    const items = getSelItems();
    if (!items.length) return;
    state.clipboard = { op: "move", items };
    toast(`已剪切 ${items.length} 项`, "ok"); updateSelectionUI();
  }
  async function doPaste(destPath) {
    if (!state.clipboard) return;
    const dest = destPath !== undefined ? destPath : state.path;
    const sources = state.clipboard.items.map((i) => i.path);
    try {
      const r = state.clipboard.op === "copy"
        ? await post("/api/copy", { sources, dest })
        : await post("/api/move", { sources, dest });
      const keep = state.clipboard.op === "copy";
      state.clipboard = keep ? state.clipboard : null;
      toast(state.clipboard ? "已复制" : "已移动", "ok");
      loadList();
    } catch (e) { toast("粘贴失败：" + e.message, "err"); }
  }

  // ---------- 上传 ----------
  function triggerUpload() {
    $("#fileInput").value = "";
    $("#fileInput").click();
  }
  function triggerUploadDir() {
    $("#dirInput").value = "";
    $("#dirInput").click();
  }
  $("#fileInput").addEventListener("change", (e) => {
    if (e.target.files.length) uploadFilesWithConfirm(e.target.files);
  });
  $("#dirInput").addEventListener("change", (e) => {
    if (e.target.files.length) uploadFilesWithConfirm(e.target.files);
  });
  async function uploadFiles(fileList, opts = {}) {
    const overwrite = !!opts.overwrite;
    const skip = opts.skip || new Set();
    const fd = new FormData();
    fd.append("path", state.path);
    if (overwrite) fd.append("overwrite", "1");
    let count = 0;
    for (const f of fileList) {
      const rel = f.webkitRelativePath || f.name;
      if (skip.has(rel)) continue;
      fd.append("files", f, rel);
      count++;
    }
    if (count === 0) { toast("已跳过全部同名文件", "ok"); return; }
    setStatus("上传中…");
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw new Error(d.error || "上传失败");
      toast(`已上传 ${d.saved.length} 个文件`, "ok");
      loadList();
    } catch (e) { toast("上传失败：" + e.message, "err"); }
  }

  // 上传前检测同名冲突，弹窗让用户选择 覆盖 / 跳过 / 取消
  async function uploadFilesWithConfirm(fileList) {
    const rels = [...fileList].map((f) => f.webkitRelativePath || f.name);
    let exists = [];
    try {
      const d = await post("/api/exists", { path: state.path, files: rels });
      exists = (d && d.exists) || [];
    } catch (e) { /* 检测失败则按默认（去重）直接上传 */ }
    if (!exists.length) { return uploadFiles(fileList); }
    const names = exists.map((n) => escapeHtml(n)).join("、");
    openModal("文件已存在",
      `<p>以下 ${exists.length} 个文件在目标位置已存在，是否覆盖？</p><p class="hint">${names}</p>`,
      [
        { text: "取消", onClick: closeModal },
        { text: "跳过同名", onClick: () => { closeModal(); uploadFiles(fileList, { skip: new Set(exists) }); } },
        { text: "覆盖全部", cls: "primary", onClick: () => { closeModal(); uploadFiles(fileList, { overwrite: true }); } },
      ]);
  }

  // ---------- 下载 ----------
  function downloadOne(path) {
    const a = document.createElement("a");
    a.href = "/api/download?path=" + enc(path);
    a.download = "";
    a.click();
  }
  async function doDownload() {
    const items = getSelItems();
    if (!items.length) return;
    if (items.length === 1) { downloadOne(items[0].path); return; }
    try {
      // 二进制下载：直接 fetch + blob，绕开 api() 的 .json() 解析（zip 字节流非 JSON，会被静默吞成 null）
      const r = await fetch("/api/download_zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: items.map((i) => i.path) }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "download.zip"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast("下载失败：" + e.message, "err"); }
  }

  // ---------- 运行 ----------
  function runItem(it) {
    const target = it || getSelItems().find((i) => /\.php$/i.test(i.name)) || getSelItems()[0];
    if (!target) return;
    if (target.is_dir) { window.open("/serve/" + enc(target.path) + "/", "_blank"); return; }
    window.open("/serve/" + enc(target.path), "_blank");
  }

  // ---------- 编辑器 ----------
  let editingPath = null;
  let _gutterLines = 0;
  // 行数标尺：与 #codeArea 字体/行高/padding 完全一致；行数未变则不重建，避免大文件卡
  function updateGutter() {
    const ta = document.getElementById("codeArea");
    const gut = document.getElementById("edGutter");
    if (!ta || !gut) return;
    const n = ta.value.split("\n").length;
    if (n === _gutterLines) return;
    _gutterLines = n;
    let s = "";
    for (let i = 1; i <= n; i++) s += i + (i < n ? "\n" : "");
    gut.textContent = s;
  }
  function closeEditor() {
    const em = $("#editModal");
    if (em) em.hidden = true;
    editingPath = null;
    _gutterLines = 0;
  }
  async function openEditor(it) {
    const item = it || getSelItems()[0];
    if (!item) return;
    try {
      const d = await api("/api/read?path=" + enc(item.path));
      editingPath = item.path;
      $("#editTitle").textContent = "编辑 · " + item.name;
      $("#editMeta").textContent = (d.size / 1024).toFixed(1) + " KB";
      const ta = $("#codeArea");
      if (ta) {
        ta.value = d.content || "";
        ta.scrollTop = 0;
        const g = document.getElementById("edGutter");
        if (g) g.scrollTop = 0;
        updateGutter();
      }
      $("#editModal").hidden = false;
      setTimeout(() => { const t = $("#codeArea"); if (t) t.focus(); }, 50);
    } catch (e) { toast("无法打开：" + e.message, "err"); }
  }
  async function saveEditor() {
    if (!editingPath) return;
    const ta = $("#codeArea");
    const content = ta ? ta.value : "";
    try {
      await post("/api/save", { path: editingPath, content });
      toast("已保存", "ok");
      closeEditor();
    } catch (e) { toast("保存失败：" + e.message, "err"); }
  }
  // 用 addEventListener 绑定，更可靠
  document.getElementById("editSave").addEventListener("click", saveEditor);
  document.getElementById("editCancel").addEventListener("click", closeEditor);
  // 点击遮罩层关闭编辑器
  document.getElementById("editModal").addEventListener("click", function(e) {
    if (e.target === this) closeEditor();
  });
  $("#codeArea").addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.target, s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 4;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault(); saveEditor();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault(); openFindBar();
    }
  });
  // 行数标尺同步：input 重算行数；scroll 把 textarea 的 scrollTop 同步给 gutter
  $("#codeArea").addEventListener("input", updateGutter);
  $("#codeArea").addEventListener("scroll", function () {
    const g = document.getElementById("edGutter");
    if (g) g.scrollTop = this.scrollTop;
  });

  // ---------- 编辑器 查找 / 替换 / 刷新 (纯 textarea, 无高亮, 仅光标跳转) ----------
  function _computeMatches(term) {
    const txt = $("#codeArea").value;
    const arr = [];
    if (!term) return arr;
    let idx = 0;
    while ((idx = txt.indexOf(term, idx)) !== -1) { arr.push(idx); idx += term.length; }
    return arr;
  }
  function _scrollMatchIntoView(idx) {
    const ta = $("#codeArea");
    const g = document.getElementById("edGutter");
    const lineH = 13 * 1.6; // 与 #codeArea line-height 一致
    const lineNo = ta.value.substring(0, idx).split("\n").length;
    ta.scrollTop = Math.max(0, (lineNo - 4) * lineH);
    if (g) g.scrollTop = ta.scrollTop;
  }
  function _doFind(dir) {
    const ta = $("#codeArea");
    const term = $("#edFindInput").value;
    if (!term) { $("#edFindCount").textContent = ""; return; }
    const matches = _computeMatches(term);
    if (matches.length === 0) { $("#edFindCount").textContent = "0/0"; return; }
    let cur;
    if (dir > 0) {
      cur = matches.findIndex(p => p >= ta.selectionEnd);
      if (cur === -1) cur = 0; // 回绕到首处
    } else {
      let k = -1;
      for (let i = 0; i < matches.length; i++) { if (matches[i] < ta.selectionStart) k = i; else break; }
      cur = k === -1 ? matches.length - 1 : k; // 回绕到末处
    }
    const m = matches[cur];
    ta.focus();
    ta.setSelectionRange(m, m + term.length);
    $("#edFindCount").textContent = (cur + 1) + "/" + matches.length;
    _scrollMatchIntoView(m);
  }
  function _replaceOne() {
    const ta = $("#codeArea");
    const term = $("#edFindInput").value;
    const rep = $("#edReplaceInput").value;
    if (!term) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (ta.value.substring(s, e) !== term) { _doFind(1); return; } // 当前未选中匹配 → 先找
    ta.value = ta.value.substring(0, s) + rep + ta.value.substring(e);
    ta.selectionStart = ta.selectionEnd = s + rep.length;
    updateGutter();
    _doFind(1); // 跳到下一个
  }
  function _replaceAll() {
    const ta = $("#codeArea");
    const term = $("#edFindInput").value;
    const rep = $("#edReplaceInput").value;
    if (!term) return;
    const src = ta.value;
    let out = "", i = 0, cnt = 0;
    while (i < src.length) {
      const j = src.indexOf(term, i);
      if (j === -1) { out += src.substring(i); break; }
      out += src.substring(i, j) + rep;
      i = j + term.length; cnt++;
    }
    if (cnt > 0) {
      ta.value = out;
      updateGutter();
      toast("已替换 " + cnt + " 处", "ok");
    } else {
      toast("未找到匹配", "err");
    }
  }
  function openFindBar() {
    const bar = $("#edFindBar");
    if (bar) { bar.hidden = false; const inp = $("#edFindInput"); if (inp) inp.focus(); }
  }
  function closeFindBar() {
    const bar = $("#edFindBar");
    if (bar) bar.hidden = true;
    $("#edFindCount").textContent = "";
  }
  async function reloadEditor() {
    if (!editingPath) return;
    try {
      const d = await api("/api/read?path=" + enc(editingPath));
      const ta = $("#codeArea");
      ta.value = d.content || "";
      ta.scrollTop = 0;
      const g = document.getElementById("edGutter");
      if (g) g.scrollTop = 0;
      updateGutter();
      toast("已从服务器重读", "ok");
    } catch (e) { toast("刷新失败：" + e.message, "err"); }
  }
  // 查找栏 / 刷新 绑定
  document.getElementById("editFind").addEventListener("click", openFindBar);
  document.getElementById("editReload").addEventListener("click", reloadEditor);
  document.getElementById("edFindClose").addEventListener("click", closeFindBar);
  document.getElementById("edFindNext").addEventListener("click", () => _doFind(1));
  document.getElementById("edFindPrev").addEventListener("click", () => _doFind(-1));
  document.getElementById("edReplaceOne").addEventListener("click", _replaceOne);
  document.getElementById("edReplaceAll").addEventListener("click", _replaceAll);
  $("#edFindInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); _doFind(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeFindBar(); }
  });
  $("#edReplaceInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); _replaceOne(); }
  });

  // ---------- 设置 ----------
  function openSettings() {
    const info = App;
    openModal("环境信息",
      `<div class="kv">
        <div class="row"><span class="k">PHP 版本</span><span class="v">${info.phpVersion || "未配置"}</span></div>
        <div class="row"><span class="k">PHP 运行时</span><span class="v">${info.phpOk ? "已就绪" : "未检测到"}</span></div>
        <div class="row"><span class="k">文档根目录</span><span class="v">${info.docRoot}</span></div>
        <div class="row"><span class="k">面板版本</span><span class="v">v${info.appVersion || "dev"}</span></div>
      </div>
      <p class="hint">如需更换 PHP，请在启动前设置环境变量 <code>PHP_CGI</code> 指向 <code>php-cgi.exe</code>，例如：<br>
      <code>set PHP_CGI=C:\\php-8.3.31-nts-Win32-vs16-x64\\php-cgi.exe</code><br>
      文档根目录可通过 <code>PHP_SERVER_DOCROOT</code> 与端口 <code>PHP_SERVER_PORT</code> 配置。</p>`,
      [{ text: "关闭", cls: "primary", onClick: closeModal }]);
  }

  // ---------- 工具栏绑定 ----------
  $$("[data-act]").forEach((b) => {
    b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "newfile") doCreate("file");
      else if (act === "newfolder") doCreate("dir");
      else if (act === "upload") triggerUpload();
      else if (act === "uploaddir") triggerUploadDir();
      else if (act === "download") doDownload();
      else if (act === "run") runItem();
      else if (act === "refresh") loadList();
    });
  });
  $$("[data-view]").forEach((b) => {
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      $$("[data-view]").forEach((x) => x.classList.toggle("active", x === b));
      renderList(); renderGrid();
    });
  });

  // 下拉菜单：点击切换、点击外部关闭
  function closeAllDropdowns() {
    $$(".dropdown-menu").forEach((m) => { m.hidden = true; });
    $$("[data-drop]").forEach((b) => b.classList.remove("open"));
  }
  $$("[data-drop]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector(".dropdown-menu");
      const willOpen = menu.hidden;
      closeAllDropdowns();
      if (willOpen) { menu.hidden = false; btn.classList.add("open"); }
    });
  });
  $$(".dropdown-menu").forEach((menu) => {
    menu.addEventListener("click", (e) => {
      if (e.target.closest(".menu-item")) closeAllDropdowns();
    });
  });
  document.addEventListener("click", closeAllDropdowns);

  $("#btnSettings").onclick = openSettings;
  $("#btnRestart").onclick = restartServer;
  $("#btnShares").onclick = showShareList;

  // ESC 关闭弹窗
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); closeEditor(); $("#ctxmenu").hidden = true; closeAllDropdowns(); }
  });

  // ---------- 用户 / 登出 ----------
  function renderUserBox() {
    const box = $("#userBox");
    if (!box) return;
    const u = (App && App.username) || "";
    box.innerHTML =
      '<span class="user-name">👤 ' + escapeHtml(u) + '</span>' +
      '<button class="icon-btn" id="btnLogout" title="退出登录">⏻</button>';
    const lo = $("#btnLogout");
    if (lo) lo.addEventListener("click", logout);
  }
  async function logout() {
    try { await post("/api/logout", {}); } catch (e) {}
    window.location.href = "/login";
  }

  // 启动：支持通过 ?path= 在新窗口定位目录
  const _up = new URLSearchParams(location.search).get("path");
  if (_up) state.path = _up;
  renderUserBox();
  loadTree();
  loadList(state.path);
  setStatus(App.phpOk ? "PHP " + App.phpVersion + " 已就绪" : "PHP 未配置，仅静态与文件管理可用");
  $("#btnCron").onclick = openCron;

  // ===== 计划任务 =====
  const CRON_TYPES = { shell: "Shell命令", url: "访问URL", php: "PHP脚本", backup: "备份" };
  const CRON_UNITS = { minute: "分钟", hour: "小时", day: "天", week: "周", month: "月" };
  let _cronEditing = null;

  function fmtTs(ts) {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function openCron() {
    $("#cronModal").hidden = false;
    $("#cronListView").hidden = false;
    $("#cronFormView").hidden = true;
    $("#cronListHead").hidden = false;
    $("#cronTitle").textContent = "计划任务";
    loadCronList();
  }
  function closeCron() { $("#cronModal").hidden = true; }

  async function loadCronList() {
    const tbody = $("#cronBodyRows");
    try {
      const d = await api("/api/cron/list");
      const tasks = d.tasks || [];
      if (!tasks.length) { tbody.innerHTML = ""; $("#cronEmpty").hidden = false; return; }
      $("#cronEmpty").hidden = true;
      tbody.innerHTML = tasks.map((t) => {
        const sched = t.schedule_mode === "cron"
          ? ("cron: " + escapeHtml(t.cron || ""))
          : ("每" + (CRON_UNITS[(t.simple && t.simple.unit)] || "天") + ((t.simple && t.simple.interval > 1) ? t.simple.interval : ""));
        const status = t.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge off">停用</span>';
        return `<tr data-id="${t.id}">
          <td>${escapeHtml(t.name || "")}</td>
          <td>${CRON_TYPES[t.type] || t.type}</td>
          <td>${escapeHtml(sched)}</td>
          <td>${status}</td>
          <td>${fmtTs(t.last_run)}${t.last_status ? " (" + (t.last_status === "success" ? "成功" : "失败") + ")" : ""}</td>
          <td>${fmtTs(t.next_run)}</td>
          <td class="cron-ops">
            <button class="mini" data-act="run">执行</button>
            <button class="mini" data-act="toggle">${t.enabled ? "停用" : "启用"}</button>
            <button class="mini" data-act="edit">编辑</button>
            <button class="mini" data-act="log">日志</button>
            <button class="mini danger" data-act="del">删除</button>
          </td>
        </tr>`;
      }).join("");
    } catch (e) { console.warn("cron list failed:", e); tbody.innerHTML = ""; $("#cronEmpty").hidden = false; }
  }

  $("#cronBodyRows").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const id = tr.dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === "run") {
        const d = await post("/api/cron/run", { id });
        toast(d.ok ? "已执行一次" : "执行失败", d.ok ? "" : "err");
        if (d.detail) console.log(d.detail);
        await loadCronList();
      } else if (act === "toggle") {
        const enabled = btn.textContent === "启用";
        await post("/api/cron/toggle", { id, enabled });
        await loadCronList();
      } else if (act === "edit") {
        const all = (await api("/api/cron/list")).tasks;
        showCronForm(all.find((x) => x.id === id) || null);
      } else if (act === "del") {
        if (!confirm("确认删除该任务？")) return;
        await post("/api/cron/delete", { id });
        toast("已删除");
        await loadCronList();
      } else if (act === "log") {
        showCronLog(id);
      }
    } catch (err) { toast("操作失败: " + err.message, "err"); }
  });
  $("#cronAddBtn").onclick = () => showCronForm(null);
  $("#cronClose").onclick = closeCron;
  $("#cronModal").addEventListener("click", (e) => { if (e.target.id === "cronModal") closeCron(); });

  function showCronForm(t) {
    _cronEditing = t;
    $("#cronListView").hidden = true;
    $("#cronFormView").hidden = false;
    document.querySelector("#cronListHead .head-actions").style.display = "none";
    const v = t || {};
    const type = v.type || "shell";
    const mode = v.schedule_mode || "simple";
    const s = v.simple || {};
    const b = v.backup || {};
    const isEdit = !!t;
    $("#cronTitle").textContent = isEdit ? "编辑计划任务" : "添加计划任务";
    const initUnit = (s.unit in {day:1,week:1,month:1,hour:1,minute:1,random:1}) ? s.unit : "day";
    const safeName = escapeHtml(v.name || "");
    const safeCron = escapeHtml(v.cron || "0 * * * *");
    const safeCmd = escapeHtml(v.command || "");
    const safeUrl = escapeHtml(v.url || "");
    const safeBody = escapeHtml(v.body || "");
    const safePhpPath = escapeHtml(v.php_path || "");
    const srcDest = escapeHtml(b.src || "");
    const dstDest = escapeHtml(b.dest || "");
    const html = `
      <div class="cron-form">
        <!-- 任务类型 + 问号 + 进程锁 -->
        <div class="cf-row">
          <label>任务类型</label>
          <div class="cf-typebar">
            <select id="cf_type">${Object.entries(CRON_TYPES).map(function(e){return '<option value="'+e[0]+'"'+(e[0]===type?' selected':'')+'>'+e[1]+'</option>'}).join("")}</select>
            <span class="cf-tip-icon" data-tip="Shell脚本：执行系统命令\n访问URL：访问HTTP接口\nPHP脚本：执行PHP文件\n备份任务：打包目录或数据库">?</span>
          </div>
        </div>

        <!-- 任务名称 必填 -->
        <div class="cf-row">
          <label><span class="cf-req">*</span>任务名称</label>
          <div class="cf-control"><input id="cf_name" type="text" value="${safeName}" placeholder="请输入计划任务名称"></div>
        </div>

        <!-- 执行周期：可视化组合 + 进程锁同行 + 预览 -->
        <div class="cf-row align-top" id="cf_simple">
          <label>执行周期</label>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <div class="cf-period" id="cf_grid">
                <select id="cf_unit">
                  <option value="day" ${initUnit==="day"?"selected":""}>每天</option>
                  <option value="week" ${initUnit==="week"?"selected":""}>每周</option>
                  <option value="month" ${initUnit==="month"?"selected":""}>每月</option>
                  <option value="hour" ${initUnit==="hour"?"selected":""}>小时</option>
                  <option value="minute" ${initUnit==="minute"?"selected":""}>分钟</option>
                  <option value="random" ${initUnit==="random"?"selected":""}>随机(白天)</option>
                </select>
                <span class="lbl" data-show="day|week|month">时</span>
                <input class="hhmm" id="cf_hour" type="number" min="0" max="23" value="${s.hour!=null?s.hour:1}" data-show="day|week|month">
                <span class="sep" data-show="day|week|month">:</span>
                <span class="lbl" data-show="day|week|month">分</span>
                <input class="hhmm" id="cf_minute" type="number" min="0" max="59" value="${s.minute!=null?s.minute:30}" data-show="day|week|month">
                <select id="cf_weekday" data-show="week">
                  <option value="1" ${s.weekday===1?"selected":""}>周一</option>
                  <option value="2" ${s.weekday===2?"selected":""}>周二</option>
                  <option value="3" ${s.weekday===3?"selected":""}>周三</option>
                  <option value="4" ${s.weekday===4?"selected":""}>周四</option>
                  <option value="5" ${s.weekday===5?"selected":""}>周五</option>
                  <option value="6" ${s.weekday===6?"selected":""}>周六</option>
                  <option value="0" ${(s.weekday===0||s.weekday==null)?"selected":""}>周日</option>
                </select>
                <span class="lbl" data-show="month">每月</span>
                <input class="mday" id="cf_day" type="number" min="1" max="31" value="${s.day!=null?s.day:1}" data-show="month">
                <span class="lbl" data-show="month">号</span>
                <input class="num" id="cf_interval" type="number" min="1" max="999" value="${s.interval||1}" data-show="hour|minute">
                <span class="lbl" data-show="hour">小时执行一次</span>
                <span class="lbl" data-show="minute">分钟执行一次</span>
                <span class="lbl" data-show="random">每天</span>
                <input class="hhmm" id="cf_rstart" type="number" min="0" max="23" value="${s.rstart!=null?s.rstart:6}" data-show="random">
                <span class="lbl" data-show="random">点 至</span>
                <input class="hhmm" id="cf_rend" type="number" min="0" max="23" value="${s.rend!=null?s.rend:22}" data-show="random">
                <span class="lbl" data-show="random">点 之间随机</span>
              </div>
              <label class="cf-proclock" style="margin-left:auto;white-space:nowrap;"><input type="checkbox" id="cf_proclock" ${v.proclock ? "checked" : ""}> 开启进程锁（防重叠执行）</label>
            </div>
            <div class="cf-preview" id="cf_preview">每天 01:30 执行一次</div>
          </div>
        </div>

        <!-- Cron 表达式（高级折叠） -->
        <details class="cf-advanced" id="cf_cronbox" ${mode==="cron"?"open":""}>
          <summary><span>高级模式 (Cron 表达式)</span></summary>
          <div class="cf-row">
            <label>Cron 表达式</label>
            <div class="cf-control"><input id="cf_cron" type="text" value="${safeCron}" placeholder="分 时 日 月 周，如 0 2 * * *"></div>
          </div>
        </details>
        <input type="hidden" id="cf_mode" value="${mode}">

        <!-- 执行用户（只读展示） -->
        <div class="cf-row">
          <label>执行用户</label>
          <div class="cf-userbox">默认使用管理员账号执行（${escapeHtml(App.username || "管理员")}）</div>
        </div>

        <!-- Shell / URL / PHP / Backup 各自控件 -->
        <div id="cf_shell" class="${type!=="shell"?"hidden":""}">
          <div class="cf-row align-top">
            <label><span class="cf-req">*</span>脚本内容</label>
            <div class="cf-shell-row">
              <textarea id="cf_command" placeholder="请输入脚本内容">${safeCmd}</textarea>
              <button type="button" class="cf-pick-btn" id="cf_pick_btn">选择脚本</button>
            </div>
          </div>
        </div>
        <div id="cf_url" class="${type!=="url"?"hidden":""}">
          <div class="cf-row"><label>URL</label><div class="cf-control"><input id="cf_urlv" type="text" value="${safeUrl}" placeholder="https://..."></div></div>
          <div class="cf-row"><label>请求方法</label><div class="cf-control">
            <select id="cf_method"><option value="GET" ${v.method==="GET"||!v.method?"selected":""}>GET</option><option value="POST" ${v.method==="POST"?"selected":""}>POST</option></select>
          </div></div>
          <div class="cf-row align-top"><label>请求体(POST)</label><div class="cf-control"><textarea id="cf_body">${safeBody}</textarea></div></div>
        </div>
        <div id="cf_php" class="${type!=="php"?"hidden":""}">
          <div class="cf-row"><label>PHP脚本路径</label><div class="cf-control"><input id="cf_phppath" type="text" value="${safePhpPath}" placeholder="相对文档根，如 os/cron.php"></div></div>
        </div>
        <div id="cf_backup" class="${type!=="backup"?"hidden":""}">
          <div class="cf-row"><label>备份类型</label><div class="cf-control">
            <select id="cf_bktype">
              <option value="dir" ${(b.target||"dir")==="dir"?"selected":""}>目录</option>
              <option value="mysql" ${b.target==="mysql"?"selected":""}>MySQL</option>
            </select>
          </div></div>
          <div id="cf_bkdir">
            <div class="cf-row"><label>源目录</label><div class="cf-control"><input id="cf_src" type="text" value="${srcDest}" placeholder="如 /www/os"></div></div>
            <div class="cf-row"><label>目标zip</label><div class="cf-control"><input id="cf_dest" type="text" value="${dstDest}" placeholder="如 /backup/os.zip"></div></div>
          </div>
          <div id="cf_bkmysql" class="cf-hidden">
            <div class="cf-row"><label>主机</label><div class="cf-control"><input id="cf_bkhost" type="text" value="${escapeHtml(b.host || "127.0.0.1")}"></div></div>
            <div class="cf-row"><label>端口</label><div class="cf-control"><input id="cf_bkport" type="text" value="${escapeHtml(b.port || "3306")}"></div></div>
            <div class="cf-row"><label>用户</label><div class="cf-control"><input id="cf_bkuser" type="text" value="${escapeHtml(b.user || "")}"></div></div>
            <div class="cf-row"><label>密码</label><div class="cf-control"><input id="cf_bkpwd" type="password" value="${escapeHtml(b.password || "")}"></div></div>
            <div class="cf-row"><label>数据库</label><div class="cf-control"><input id="cf_bkdb" type="text" value="${escapeHtml(b.db || "")}"></div></div>
            <div class="cf-row"><label>目标sql</label><div class="cf-control"><input id="cf_bkdest" type="text" value="${dstDest}" placeholder="如 /backup/db.sql"></div></div>
          </div>
        </div>

        <!-- 温馨提示（仅 shell） -->
        <div id="cf_tip_shell" class="${type!=="shell"?"cf-hidden":""}">
          <div class="cf-tip">
            <b>温馨提示</b>　为了保证服务器的安全稳定，shell 脚本中以下命令不可使用：<br>
            <span style="margin-left:14px;display:inline-block;">shutdown, init 0, mkfs, passwd, chpasswd, --stdin, mkfs.ext, mke2fs</span>
          </div>
        </div>

        <!-- 超时 + 启用（底部高级选项） -->
        <details class="cf-advanced">
          <summary><span>高级选项</span></summary>
          <div class="cf-row"><label>超时(秒)</label><div class="cf-control"><input id="cf_timeout" type="number" value="${v.timeout || 300}" min="1"></div></div>
          <div class="cf-row"><label>是否启用</label><div class="cf-control"><label style="display:inline-flex;align-items:center;gap:6px;"><input type="checkbox" id="cf_enabled" ${v.enabled!==false?"checked":""}> 启用本任务</label></div></div>
        </details>

        <div class="cf-foot">
          <button class="btn ghost" id="cfCancel">取消</button>
          <button class="btn primary" id="cfSave">${isEdit?"确定(更新)":"确定"}</button>
        </div>
      </div>`;
    $("#cronFormView").innerHTML = html;

    // —— 周期控件：按单位切换可见子控件 + 实时预览 ——
    const wkday = ["周日","周一","周二","周三","周四","周五","周六"];
    const pad = function(n){return String(n).padStart(2,"0");};
    function updatePreview() {
      const unit = $("#cf_unit").value;
      const interval = $("#cf_interval").value || 1;
      const h = $("#cf_hour").value, m = $("#cf_minute").value;
      const w = $("#cf_weekday").value, d = $("#cf_day").value;
      let txt = "";
      if (unit === "day")   txt = "每天的 " + pad(h) + ":" + pad(m) + " 执行一次";
      else if (unit === "week")  txt = "每周" + wkday[parseInt(w,10)] + " 的 " + pad(h) + ":" + pad(m) + " 执行一次";
      else if (unit === "month") txt = "每月的 " + d + " 号 " + pad(h) + ":" + pad(m) + " 执行一次";
      else if (unit === "hour")  txt = "每隔 " + interval + " 小时执行一次";
      else if (unit === "minute") txt = "每隔 " + interval + " 分钟执行一次";
      else if (unit === "random") txt = "每天在 " + $("#cf_rstart").value + ":00-" + $("#cf_rend").value + ":00 之间随机时刻执行一次";
      $("#cf_preview").textContent = txt;
      $("#cf_grid").querySelectorAll("[data-show]").forEach(function(el) {
        const allow = el.getAttribute("data-show").split("|");
        el.classList.toggle("cf-hidden", !allow.includes(unit));
      });
    }
    $("#cf_unit").onchange = updatePreview;
    $("#cf_hour").oninput = updatePreview;
    $("#cf_minute").oninput = updatePreview;
    $("#cf_interval").oninput = updatePreview;
    $("#cf_weekday").onchange = updatePreview;
    $("#cf_day").oninput = updatePreview;
    updatePreview();

    // —— Cron 折叠：打开高级即切换 mode，关闭即 simple ——
    const cronDetails = $("#cf_cronbox");
    function syncCronMode() {
      $("#cf_mode").value = cronDetails.open ? "cron" : "simple";
    }
    cronDetails.addEventListener("toggle", syncCronMode);
    syncCronMode();

    // —— 类型切换 ——
    $("#cf_type").onchange = function() {
      const ty = $("#cf_type").value;
      ["shell","url","php","backup"].forEach(function(x){ $("#cf_" + x).classList.toggle("hidden", x !== ty); });
      $("#cf_tip_shell").classList.toggle("cf-hidden", ty !== "shell");
    };
    $("#cf_bktype").onchange = function() {
      const ty = $("#cf_bktype").value;
      $("#cf_bkdir").classList.toggle("hidden", ty !== "dir");
      $("#cf_bkmysql").classList.toggle("hidden", ty !== "mysql");
    };
    $("#cfCancel").onclick = function() { $("#cronFormView").hidden = true; $("#cronListView").hidden = false; $("#cronTitle").textContent = "计划任务"; document.querySelector("#cronListHead .head-actions").style.display = "flex"; };
    $("#cfSave").onclick = saveCron;

    // —— Shell 模式「选择脚本」按钮：弹模态文件浏览器（白名单根）——
    const pickBtn = $("#cf_pick_btn");
    if (pickBtn) pickBtn.onclick = function() { openScriptPicker(); };
  }

  // ============================================================
  // Shell 脚本选择器（计划任务表单用）
  // ============================================================
  function _pickerScriptExt(name) {
    // 可执行的脚本类型，外部图标参考 file_manager
    const e = (name.split(".").pop() || "").toLowerCase();
    return ["py","sh","bat","ps1","php","js","pl","rb"].includes(e) ? e : "";
  }

  // 把选中脚本路径回填到命令输入框：保留已有解释器(第一段),替换最后一段为选中绝对路径
  function _applyPickedScriptToCommand(absPath) {
    const ta = $("#cf_command");
    if (!ta) return;
    const cur = (ta.value || "").trim();
    let head = "";
    if (cur) {
      // 按空白行/换行分段，保留除最后一段以外的所有内容
      const lines = cur.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length >= 2) {
        head = lines.slice(0, -1).join("\n") + "\n";
      }
    }
    ta.value = head + absPath;
    ta.dispatchEvent(new Event("input"));
    toast("已填入脚本路径");
  }

  async function openScriptPicker() {
    // 打开模态 + 列出白名单根目录
    openModal("选择脚本",
      `<div class="picker">
         <div class="picker-bar">
           <span class="picker-lbl">根目录</span>
           <select id="pk_root"></select>
           <button type="button" class="btn ghost" id="pk_up">↑ 上级</button>
         </div>
         <div class="picker-crumb" id="pk_crumb">/</div>
         <div class="picker-list" id="pk_list"><div class="picker-empty">加载中…</div></div>
         <div class="picker-hint">仅可浏览白名单目录内的脚本文件。已选:
           <code id="pk_picked">(未选)</code>
         </div>
       </div>`,
      [
        { text: "取消", onClick: closeModal },
        { text: "填入脚本路径", cls: "primary", onClick: function() {
            const v = $("#pk_picked").getAttribute("data-abs") || "";
            if (!v) { toast("请先选中一个脚本", "err"); return; }
            _applyPickedScriptToCommand(v);
            closeModal();
        } },
      ],
      "wide"
    );

    let state = { root: 0, rel: "" };

    async function refresh() {
      const data = await api("/api/script_browse?root=" + state.root + "&path=" + enc(state.rel));
      // 填充根下拉
      const sel = $("#pk_root");
      sel.innerHTML = data.roots.map(r =>
        `<option value="${r.idx}" ${r.idx===state.root?"selected":""}>${escapeHtml(r.label)} — ${escapeHtml(r.abs)}</option>`
      ).join("");
      sel.onchange = function() { state.root = parseInt(sel.value, 10); state.rel = ""; refresh(); };

      // 面包屑
      $("#pk_crumb").textContent = (data.roots[state.root].abs + (state.rel ? "/" + state.rel : "")).replace(/\\/g, "/");

      // 列表
      const wrap = $("#pk_list");
      if (!data.entries.length) {
        wrap.innerHTML = `<div class="picker-empty">目录为空</div>`;
      } else {
        wrap.innerHTML = data.entries.map(function(it) {
          const icon = it.is_dir ? "📁" : (_pickerScriptExt(it.name) ? "📜" : "📄");
          return `
            <div class="picker-row ${it.is_dir?"is-dir":""}" data-abs="${String(it.abs).replace(/"/g,'&quot;')}" data-isdir="${it.is_dir?"1":"0"}">
              <span class="picker-ico">${icon}</span>
              <span class="picker-name">${escapeHtml(it.name)}</span>
              <span class="picker-size">${it.size_text || ""}</span>
              <button type="button" class="picker-pick" data-abs="${String(it.abs).replace(/"/g,'&quot;')}" data-isdir="${it.is_dir?"1":"0"}">${it.is_dir?"进入":"选中"}</button>
            </div>`;
        }).join("");
        // 行点击 → 子目录进入 / 文件标记选中
        const rootAbs = data.roots[state.root].abs.replace(/\\/g, "/");
        function relOf(abs) {
          return abs.replace(/\\/g, "/").slice(rootAbs.length).replace(/^\/+/, "");
        }
        wrap.querySelectorAll(".picker-row").forEach(function(row) {
          row.addEventListener("click", function(ev) {
            if (ev.target.closest(".picker-pick")) return; // 按钮自己处理
            const abs = row.getAttribute("data-abs");
            const isDir = row.getAttribute("data-isdir") === "1";
            if (isDir) { state.rel = relOf(abs); refresh(); }
            else { $("#pk_picked").textContent = abs; $("#pk_picked").setAttribute("data-abs", abs); }
          });
        });
        wrap.querySelectorAll(".picker-pick").forEach(function(btn) {
          btn.addEventListener("click", function(ev) {
            ev.stopPropagation();
            const abs = btn.getAttribute("data-abs");
            const isDir = btn.getAttribute("data-isdir") === "1";
            if (isDir) { state.rel = relOf(abs); refresh(); }
            else { $("#pk_picked").textContent = abs; $("#pk_picked").setAttribute("data-abs", abs); }
          });
        });
      }

      // 上级按钮: 仅在非根时可点
      const upBtn = $("#pk_up");
      upBtn.disabled = !data.parent_abs;
      upBtn.onclick = function() {
        if (!data.parent_abs) return;
        const rootAbs = data.roots[state.root].abs.replace(/\\/g, "/");
        const parentAbs = data.parent_abs.replace(/\\/g, "/");
        if (parentAbs === rootAbs) {
          state.rel = "";
        } else {
          state.rel = parentAbs.slice(rootAbs.length + 1);
        }
        refresh();
      };
    }
    try {
      await refresh();
    } catch (e) {
      $("#pk_list").innerHTML = `<div class="picker-empty">加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  async function saveCron() {
    const type = $("#cf_type").value;
    const mode = $("#cf_mode").value;
    const isMysql = type === "backup" && $("#cf_bktype").value === "mysql";
    const data = {
      name: $("#cf_name").value.trim() || "未命名任务",
      type,
      enabled: $("#cf_enabled").checked,
      schedule_mode: mode,
      proclock: $("#cf_proclock").checked,
      simple: {
        unit: $("#cf_unit").value,
        interval: parseInt($("#cf_interval").value || "1", 10),
        hour: parseInt($("#cf_hour").value || "0", 10),
        minute: parseInt($("#cf_minute").value || "0", 10),
        weekday: parseInt($("#cf_weekday").value || "0", 10),
        day: parseInt($("#cf_day").value || "1", 10),
        rstart: parseInt($("#cf_rstart").value || "6", 10),
        rend: parseInt($("#cf_rend").value || "22", 10),
      },
      cron: $("#cf_cron").value.trim(),
      command: $("#cf_command").value,
      url: $("#cf_urlv").value.trim(),
      method: $("#cf_method").value,
      body: $("#cf_body").value,
      php_path: $("#cf_phppath").value.trim(),
      backup: {
        target: $("#cf_bktype").value,
        src: $("#cf_src").value.trim(),
        dest: isMysql ? $("#cf_bkdest").value.trim() : $("#cf_dest").value.trim(),
        host: $("#cf_bkhost").value.trim(),
        port: $("#cf_bkport").value.trim(),
        user: $("#cf_bkuser").value.trim(),
        password: $("#cf_bkpwd").value,
        db: $("#cf_bkdb").value.trim(),
      },
      timeout: parseInt($("#cf_timeout").value || "300", 10),
    };
    try {
      if (_cronEditing) { data.id = _cronEditing.id; await post("/api/cron/update", data); toast("已更新"); }
      else { await post("/api/cron/add", data); toast("已创建"); }
      $("#cronFormView").hidden = true;
      $("#cronListView").hidden = false;
      await loadCronList();
    } catch (e) { toast("保存失败: " + e.message, "err"); }
  }

  async function showCronLog(id) {
    try {
      const d = await api("/api/cron/logs?id=" + encodeURIComponent(id));
      const log = d.log || "(暂无日志)";
      $("#cronListView").hidden = true;
      $("#cronFormView").hidden = false;
      $("#cronFormView").innerHTML = `<div class="cron-log"><pre>${escapeHtml(log)}</pre><div class="cf-foot"><button class="btn ghost" id="cfLogBack">返回</button></div></div>`;
      $("#cfLogBack").onclick = () => { $("#cronFormView").hidden = true; $("#cronListView").hidden = false; $("#cronTitle").textContent = "计划任务"; document.querySelector("#cronListHead .head-actions").style.display = "flex"; };
    } catch (e) { toast("读取日志失败: " + e.message, "err"); }
  }

})();
