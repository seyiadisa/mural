FROM caddy:2-alpine
COPY infra/gcp/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
