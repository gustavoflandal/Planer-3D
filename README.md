# Syncrofin 3D Planner

Planejador de carga 3D para caminhões e contêineres, que roda no navegador. Você monta a lista de carga, escolhe o veículo e o app posiciona os volumes automaticamente. Ele mostra a ocupação de volume, peso, piso e metros lineares, além da distribuição de peso por eixo e do centro de gravidade.

## Requisitos

- Node.js 18 ou superior (sem dependências externas)

## Uso

```bash
npm run build      # gera os arquivos estáticos em dist/
npm run check      # verificação de sintaxe + smoke test
```

Para abrir localmente, sirva a pasta `dist/` com qualquer servidor estático, por exemplo:

```bash
python -m http.server 8080 --directory dist
```

Depois abra http://127.0.0.1:8080/.

Os planos ficam guardados apenas no navegador (localStorage).

---

Desenvolvido por Gustavo F. Landal - 2026 - gustavoflandal@gmail.com
