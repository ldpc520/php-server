<?php
// 示例首页：演示 PHP 运行 + 表单交互
$msg = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $name = trim($_POST['name'] ?? '');
    $msg = $name !== '' ? '你好，' . htmlspecialchars($name, ENT_QUOTES) . '！欢迎使用 PHP 服务器 🚀' : '请输入你的名字';
}
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PHP 服务器 · 示例首页</title>
<style>
  :root{ --bg:#0f1419; --card:#1b232e; --accent:#6c8cff; --accent2:#a06bff; --text:#e6edf3; --muted:#8b97a7; }
  *{box-sizing:border-box;font-family:-apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:radial-gradient(1200px 600px at 70% -10%,#23304a 0%,var(--bg) 55%);color:var(--text);}
  .card{background:var(--card);padding:36px 40px;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.45);
        width:min(520px,92vw);border:1px solid rgba(255,255,255,.06);}
  h1{margin:0 0 6px;font-size:24px;
     background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent;}
  p.sub{color:var(--muted);margin:0 0 22px;font-size:14px;}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;background:rgba(108,140,255,.15);color:#aebfff;margin-bottom:18px;}
  form{display:flex;gap:10px;}
  input[type=text]{flex:1;padding:11px 14px;border-radius:10px;border:1px solid #2c3a4d;background:#0f1620;color:var(--text);outline:none;}
  input[type=text]:focus{border-color:var(--accent);}
  button{padding:11px 18px;border:none;border-radius:10px;cursor:pointer;font-weight:600;color:#fff;
         background:linear-gradient(90deg,var(--accent),var(--accent2));}
  button:hover{filter:brightness(1.08);}
  .msg{margin-top:18px;padding:12px 14px;border-radius:10px;background:rgba(108,140,255,.12);border:1px solid rgba(108,140,255,.25);}
  .meta{margin-top:22px;color:var(--muted);font-size:12px;line-height:1.7;}
  code{color:#9fe0c0;}
</style>
</head>
<body>
  <div class="card">
    <span class="badge">PHP <?php echo phpversion(); ?> 运行正常</span>
    <h1>🐘 PHP 服务器</h1>
    <p class="sub">这是一个由 Flask + php-cgi 驱动的简易 PHP 运行环境示例。</p>
    <form method="post">
      <input type="text" name="name" placeholder="输入你的名字…" value="<?php echo htmlspecialchars($_POST['name'] ?? '', ENT_QUOTES); ?>">
      <button type="submit">提交</button>
    </form>
    <?php if ($msg): ?><div class="msg"><?php echo $msg; ?></div><?php endif; ?>
    <div class="meta">
      服务器软件：<code><?php echo $_SERVER['SERVER_SOFTWARE'] ?? ''; ?></code><br>
      当前时间：<code><?php echo date('Y-m-d H:i:s'); ?></code><br>
      可在左侧文件管理器中编辑本文件：<code>www/index.php</code>
    </div>
  </div>
</body>
</html>
