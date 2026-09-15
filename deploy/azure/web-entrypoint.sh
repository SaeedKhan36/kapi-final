#!/bin/sh
set -eu

: "${KAPI_API_ORIGIN:=http://kapi-api}"
case "$KAPI_API_ORIGIN" in
  http://*) ;;
  *) echo "KAPI_API_ORIGIN must be an internal http:// Container App name" >&2; exit 1 ;;
esac

api_host=${KAPI_API_ORIGIN#http://}
case "$api_host" in
  ''|*[!a-zA-Z0-9.:-]*) echo "KAPI_API_ORIGIN contains unsafe characters" >&2; exit 1 ;;
esac

mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp
envsubst '${KAPI_API_ORIGIN}' \
  < /etc/kapi/nginx.conf.template \
  > /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
