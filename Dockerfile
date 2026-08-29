# 简易 PHP 服务器 / 文件管理器
# 基于 Debian 的 python:3.11-slim，通过 apt 安装 php-cgi 及常用扩展
FROM python:3.11-slim

LABEL org.opencontainers.image.title="php-server" \
      org.opencontainers.image.description="Flask + php-cgi 的简易 PHP 服务器 / 文件管理器 (宝塔风格 UI)" \
      org.opencontainers.image.source="https://github.com/ken01982/php-server" \
      maintainer="ken01982"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

# 安装 PHP(CGI) 及常用扩展（PHP 8.2，兼容 PHP 7.0+ 写法）
RUN apt-get update && apt-get install -y --no-install-recommends \
        php-cgi \
        php-curl php-mbstring php-xml php-zip php-gd \
        php-sqlite3 php-mysql php-intl php-bcmath \
    && rm -rf /var/lib/apt/lists/*

# 关闭 php-cgi 启动期错误输出，避免污染 CGI 响应头
RUN mkdir -p /etc/php \
    && for v in /etc/php/*/cgi; do \
         mkdir -p "$v/conf.d"; \
         printf 'display_errors=Off\nlog_errors=On\n' > "$v/conf.d/zz-phpserver.ini"; \
       done

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 保留一份“出厂默认站点”，供持久化卷首次为空时初始化（entrypoint 使用）
RUN cp -a /app/www /app/www_default

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 运行时环境变量（可用 -e 覆盖）
ENV PHP_SERVER_DOCROOT=/www \
    PHP_CGI=/usr/bin/php-cgi \
    PHP_SERVER_HOST=0.0.0.0 \
    PHP_SERVER_PORT=5000

EXPOSE 5000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python", "app.py"]
