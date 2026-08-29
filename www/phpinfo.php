<?php
// 环境信息演示页
header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PHP 环境信息</title>
<style>
  body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#0f1419;color:#e6edf3;margin:0;padding:30px;}
  h1{color:#6c8cff;}
  table{border-collapse:collapse;width:100%;max-width:760px;margin-top:16px;}
  td,th{border:1px solid #2c3a4d;padding:8px 12px;text-align:left;font-size:14px;}
  th{background:#1b232e;width:240px;color:#9fb3c8;}
  tr:nth-child(even){background:#141c26;}
</style>
</head>
<body>
<h1>PHP 运行环境信息</h1>
<table>
  <tr><th>PHP 版本</th><td><?php echo phpversion(); ?></td></tr>
  <tr><th>SAPI</th><td><?php echo php_sapi_name(); ?></td></tr>
  <tr><th>操作系统</th><td><?php echo PHP_OS; ?></td></tr>
  <tr><th>Zend 版本</th><td><?php echo zend_version(); ?></td></tr>
  <tr><th>已加载扩展</th><td><?php echo implode(', ', get_loaded_extensions()); ?></td></tr>
  <tr><th>当前时间</th><td><?php echo date('Y-m-d H:i:s'); ?></td></tr>
  <tr><th>文档根目录</th><td><?php echo $_SERVER['DOCUMENT_ROOT'] ?? '(unknown)'; ?></td></tr>
</table>
</body>
</html>
