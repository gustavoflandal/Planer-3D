# Syncrofin 3D Planner

Planejador de carga 3D para caminhões e contêineres, que roda no navegador. Você monta a lista de carga, escolhe o veículo e o app posiciona os volumes automaticamente. Ele mostra a ocupação de volume, peso, piso e metros lineares, além da distribuição de peso por eixo e do centro de gravidade.

## Requisitos

- Node.js 18 ou superior para o build (sem dependências do npm)

## Vista 3D

A vista 3D usa WebGL com o [Three.js](https://threejs.org) r170 (licença MIT), que vem incluído no projeto em `src/vendor/`, então não depende de CDN. O código está em `src/scene3d.js`. A cena mostra:

- caixas de papelão com o nome do item impresso, o símbolo "este lado para cima", arestas escuras e sombras suaves;
- espaço de carga com paredes onduladas abertas para quem olha e piso de chapa xadrez;
- o veículo montado a partir dos dados do espaço de carga: rodas nas distâncias dos eixos e na bitola, cabine do caminhão rígido, cavalo mecânico com prato, pés de apoio do semirreboque e cambão do reboque.

Se o navegador não tiver WebGL, ou se a página for aberta direto do disco (`file://`, onde os módulos JavaScript não carregam), o app usa o desenho 2D de antes.

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

## Espaços de carga

O espaço de carga é o veículo ou contentor onde a carga é posicionada.

- **Painel do espaço:** fica sobre a vista 3D e mostra o espaço escolhido com as dimensões internas. Uma linha traz a capacidade (peso, volume e metros livres) e outra o que a lista de carga pede; o valor fica em vermelho quando passa da capacidade.
- **Lista de espaços:** a seta ▾ do painel abre a lista. Dá para filtrar por tipo (contentores, camiões, reboques) e marcar favoritos com ★. Ao escolher um semirreboque, aparece a lista de **cavalos mecânicos**.
  - Com cavalo, a carga no pino-rei é repartida pelos eixos do cavalo.
  - Sem cavalo, só a carga no pino-rei é calculada.
- **Aba "Espaços de carga":** tabela de todos os espaços, com filtro por favorito, nome, tipo, origem e data de criação, ordenação por coluna e paginação.
  - Os espaços **padrão** podem ser editados e repostos.
  - Os **personalizados** podem ser editados e apagados.
- **Criar espaço personalizado:** campos de nome, tipo (16 tipos, incluindo semirreboque de 4 eixos, caminhão bitruck de 4 eixos e cavalo mecânico de 4 eixos), comprimento, largura e altura internos, carga máxima e bitola.
  - Cada eixo (A–E) tem distância, tara e carga máxima. No bitruck e no cavalo de 4 eixos, A e B formam o par dianteiro direcional, que divide a carga como o grupo traseiro.
  - Um diagrama lateral com as cotas acompanha os valores enquanto você digita.
  - As distâncias medem-se a partir da parede frontal do espaço de carga; nos cavalos, a partir do prato.
- **Peso por eixo:** cada eixo mostra a carga mais a tara, a carga máxima e a divisão entre rodas esquerdas e direitas, calculada pela bitola e pelo desvio lateral do centro de gravidade.

Os espaços personalizados, as edições e os favoritos ficam guardados no navegador.

O código está em `src/spaces.js` (dados, validação e cálculo de eixos, sem DOM) e `src/spaces-ui.js` (telas).

## Importar volumes de uma planilha

O botão **Importar planilha** lê um arquivo Excel (`.xlsx`) ou CSV e acrescenta os volumes à lista. O link **Baixar modelo CSV**, abaixo do formulário, baixa um modelo pronto.

- **Colunas:** são reconhecidas pelo cabeçalho, com ou sem acentos e em português ou inglês: Descrição, Comprimento, Largura, Altura, Peso, Quantidade, Destino e Cor. Sem cabeçalho, a ordem esperada é essa mesma.
- **Unidades:** as medidas são em mm, a menos que o cabeçalho diga `(cm)` ou `(m)`. O peso é em kg por unidade; um cabeçalho "Peso total" é dividido pela quantidade.
- **CSV:** aceita `;`, `,` ou tab como separador, vírgula decimal e arquivos em UTF-8 ou Windows-1252, que é como o Excel salva no Brasil.
- **Excel:** só a primeira folha é lida. Arquivos `.xls` antigos não são suportados: salve como `.xlsx` ou `.csv`.
- **Linhas inválidas** (sem medidas ou que não cabem no veículo escolhido) são ignoradas, e a mensagem indica o número de cada uma.

---

Desenvolvido por Gustavo F. Landal - 2026 - gustavoflandal@gmail.com
