# Landing page do Syncrofin 3D Planner: site estatico servido por nginx.
# Os arquivos ficam em /planner/ dentro do container, para o Caddy da VPS
# repassar syncrofin.com.br/planner/... sem precisar cortar o prefixo.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/planner/
COPY img /usr/share/nginx/html/planner/img
COPY ajuda /usr/share/nginx/html/planner/ajuda

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/planner/ > /dev/null || exit 1
