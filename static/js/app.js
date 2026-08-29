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
    $("#btnPaste").disabled = !state.clipboard;
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

  // ---------- 右键菜单 ----------
  function onCtx(e, it) {
    e.preventDefault();
    const menu = $("#ctxmenu");
    menu.innerHTML = "";
    const sel = state.selected;
    if (!sel.has(it.path) && sel.size) { state.selected.clear(); state.selected.add(it.path); updateSelectionUI(); }
    else if (!sel.has(it.path)) { state.selected.clear(); state.selected.add(it.path); updateSelectionUI(); }

    const items = [];
    if (it.is_dir) items.push({ t: "打开", f: () => openItem(it) });
    else items.push({ t: "编辑", f: () => openEditor(it) }, { t: "下载", f: () => downloadOne(it.path) });
    if (!it.is_dir && /\.php$/i.test(it.name)) items.push({ t: "▶ 运行", f: () => runItem(it) });
    items.push({ divider: true });
    items.push({ t: "重命名", f: () => doRename(it) });
    items.push({ t: "复制", f: () => doCopy() });
    items.push({ t: "剪切", f: () => doCut() });
    if (state.clipboard) items.push({ t: "粘贴到此处", f: () => doPaste(it.is_dir ? it.path : state.path) });
    items.push({ divider: true });
    items.push({ t: "删除", danger: true, f: () => doDelete() });

    items.forEach((m) => {
      if (m.divider) { const d = document.createElement("div"); d.className = "divider"; menu.appendChild(d); return; }
      const el = mk("div", "item" + (m.danger ? " danger" : ""), m.t, m.f);
      menu.appendChild(el);
    });
    menu.hidden = false;
    menu.style.left = Math.min(e.clientX, innerWidth - 180) + "px";
    menu.style.top = Math.min(e.clientY, innerHeight - 260) + "px";
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
  function openModal(title, bodyHtml, footBtns) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
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
      const r = await post("/api/download_zip", { paths: items.map((i) => i.path) });
      const blob = new Blob([r], { type: "application/zip" });
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
  function closeEditor() {
    const em = $("#editModal");
    if (em) em.hidden = true;
    editingPath = null;
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
      if (ta) { ta.value = d.content || ""; }
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
  });

  // ---------- 设置 ----------
  function openSettings() {
    const info = App;
    openModal("环境信息",
      `<div class="kv">
        <div class="row"><span class="k">PHP 版本</span><span class="v">${info.phpVersion || "未配置"}</span></div>
        <div class="row"><span class="k">PHP 运行时</span><span class="v">${info.phpOk ? "已就绪" : "未检测到"}</span></div>
        <div class="row"><span class="k">文档根目录</span><span class="v">${info.docRoot}</span></div>
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
      else if (act === "edit") openEditor();
      else if (act === "rename") doRename();
      else if (act === "copy") doCopy();
      else if (act === "cut") doCut();
      else if (act === "paste") doPaste();
      else if (act === "delete") doDelete();
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

  // 启动
  renderUserBox();
  loadTree();
  loadList("");
  setStatus(App.phpOk ? "PHP " + App.phpVersion + " 已就绪" : "PHP 未配置，仅静态与文件管理可用");
})();
