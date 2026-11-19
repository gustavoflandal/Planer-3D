# Publicar a landing page em syncrofin.com.br/planner

A página roda num container próprio (`planner-landing`, nginx) ao lado do
syncrofin e da landing do PDV-Lev, na mesma VPS. O Caddy que já atende as
portas 80/443 (`syncrofin-pessoal-caddy-1`) ganha uma regra: **tudo que começar
com `/planner` vai para este container**; o resto continua como está.

```
navegador ──► Caddy (80/443, HTTPS) ──┬─ /planner/... ─► planner-landing
                                      ├─ /pdv-lev/... ─► pdv-lev-landing
                                      └─ todo o resto ─► syncrofin
```

O container serve os arquivos em `/planner/`, então o Caddy **não corta o
prefixo** (`handle`, não `handle_path`). DNS e certificado já existem.

O Caddy redireciona `www.syncrofin.com.br` para `syncrofin.com.br`, então o
endereço final é **https://syncrofin.com.br/planner/**.

## 1. Baixar o repositório na VPS

```bash
cd /opt && git clone https://github.com/gustavoflandal/Planer-3D.git planner-landing
```

## 2. Subir o container

O `docker-compose.yml` já liga o container à rede do Caddy
(`syncrofin-pessoal_default`).

```bash
cd /opt/planner-landing/landing && docker compose up -d --build
```

Conferir que o Caddy enxerga o container pelo nome:

```bash
docker exec syncrofin-pessoal-caddy-1 wget -qO- http://planner-landing/planner/ | grep -o "<title>.*</title>"
```

Deve mostrar `<title>Syncrofin 3D Planner</title>`.

## 3. Acrescentar a regra no Caddy

O arquivo é o `Caddyfile.landing` montado no container do Caddy (fica dentro da
pasta da versão do syncrofin, ex.: `/opt/syncrofin/releases/vX.Y.Z/deploy/caddy/`).
O bloco abaixo descobre o caminho sozinho, faz backup, insere a regra antes do
`handle` final e não duplica se rodar duas vezes:

```bash
F=$(docker inspect syncrofin-pessoal-caddy-1 --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile.landing"}}{{.Source}}{{end}}{{end}}')
echo "Caddyfile: $F"
if grep -q planner-landing "$F"; then echo "JA TEM A REGRA, nada feito"; else
cp -p "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"
cat > /tmp/bloco-planner <<'EOF'
        # Landing page do Syncrofin 3D Planner: container planner-landing (/opt/planner-landing).
        handle /planner* {
                reverse_proxy planner-landing:80 {
                        # Os cabecalhos de seguranca saem do bloco header acima.
                        header_down -X-Content-Type-Options
                        header_down -Referrer-Policy
                        header_down -X-Frame-Options
                }
        }

EOF
awk 'NR==FNR {b = b $0 "\n"; next} !feito && /^[[:space:]]*handle[[:space:]]*\{[[:space:]]*$/ {printf "%s", b; feito=1} {print}' /tmp/bloco-planner "$F" > /tmp/Caddyfile.landing.novo
cat /tmp/Caddyfile.landing.novo > "$F"
echo "REGRA INCLUIDA"; fi
```

O conteúdo é gravado por cima do arquivo existente (`cat >`), não substituído
por outro arquivo: o Docker monta esse arquivo individualmente, e um arquivo
novo no lugar não seria visto pelo container.

Validar e recarregar (o reload não derruba o syncrofin):

```bash
docker exec syncrofin-pessoal-caddy-1 grep -c planner-landing /etc/caddy/Caddyfile.landing
```

```bash
docker exec syncrofin-pessoal-caddy-1 caddy validate --config /etc/caddy/Caddyfile.landing --adapter caddyfile
```

```bash
docker exec syncrofin-pessoal-caddy-1 caddy reload --config /etc/caddy/Caddyfile.landing --adapter caddyfile
```

## 4. Conferir

Abra **https://syncrofin.com.br/planner** (vira `/planner/`), confira o manual em
`/planner/ajuda/` e veja que `https://syncrofin.com.br/` e `/pdv-lev/` continuam
normais.

## Atualizar a página depois

```bash
cd /opt/planner-landing && git pull && cd landing && docker compose up -d --build
```

## Atenção: a regra do Caddy vive na pasta da versão do syncrofin

Quando uma nova versão do syncrofin for publicada, a pasta nova vem sem as
regras do `/planner` e do `/pdv-lev`. Rode de novo o passo 3 (o bloco detecta o
arquivo atual) ou inclua os blocos no `deploy/caddy/Caddyfile.landing` do
código-fonte do syncrofin.

## Desfazer

```bash
F=$(docker inspect syncrofin-pessoal-caddy-1 --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile.landing"}}{{.Source}}{{end}}{{end}}'); ls -1 "$F".bak-*
```

Copie o backup desejado por cima (`cat "$F.bak-..." > "$F"`), rode o `caddy reload`
do passo 3 e, se quiser remover o container, `docker compose down` em
`/opt/planner-landing/landing`.

## Se algo der errado

| Sintoma | Causa provável |
|---------|----------------|
| Abre a landing do syncrofin em `/planner` | A regra não foi incluída ou o Caddy não recarregou. Repita o passo 3. |
| `502 Bad Gateway` | O Caddy não alcança o container: `docker network inspect syncrofin-pessoal_default` deve listar `planner-landing`. |
| Página sem estilo nem imagens | O prefixo `/planner` foi cortado (`handle_path`) ou o `reverse_proxy` ganhou caminho. |

Logs do container: `docker logs --tail 50 planner-landing`.
