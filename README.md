# Syncrofin 3D Planner

Planejador de carga 3D para caminhões e contêineres, que roda no navegador. Você monta a lista de carga, escolhe o veículo e o app posiciona os volumes automaticamente. Ele mostra a ocupação de volume, peso, piso e metros lineares, além da distribuição de peso por eixo e do centro de gravidade.

## Requisitos

- Node.js 18 ou superior para o build (sem dependências do npm)

## Vista 3D

A vista 3D usa WebGL com o [Three.js](https://threejs.org) r170 (licença MIT), que vem incluído no projeto em `src/vendor/`, então não depende de CDN. O código está em `src/scene3d.js`. A cena mostra:

- caixas de papelão com o nome do item impresso, o símbolo "este lado para cima", arestas escuras e sombras suaves;
- espaço de carga aberto para quem olha, com piso de chapa xadrez: paredes onduladas no contêiner e painéis brancos de baú nos caminhões, reboques e semirreboques;
- o veículo montado a partir dos dados do espaço de carga: rodas nas distâncias dos eixos e na bitola (pneus arredondados, aros com porcas), cavalo mecânico com prato, tanque de combustível, pés de apoio do semirreboque, cambão do reboque, protetores laterais e para-choque traseiro;
- cabine prata de teto alto, no estilo de um cavalo europeu moderno: para-brisa inclinado, quebra-sol, grade com frisos, faróis no para-choque, janelas, retrovisores, entradas de ar, degraus e caixas de roda recortadas sobre os eixos dianteiros. A mesma cabine serve ao caminhão rígido, ajustada à altura do baú.

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
- **Lista de espaços:** a seta ▾ do painel abre a lista. Dá para filtrar por tipo (contentores, caminhões, reboques) e marcar favoritos com ★. Ao escolher um semirreboque, aparece a lista de **cavalos mecânicos**.
  - Com cavalo, a carga no pino-rei é repartida pelos eixos do cavalo.
  - Sem cavalo, só a carga no pino-rei é calculada.
- **Aba "Espaços de carga":** tabela de todos os espaços, com filtro por favorito, nome, tipo, origem e data de criação, ordenação por coluna e paginação.
  - Os espaços **padrão** podem ser editados e repostos.
  - Os **personalizados** podem ser editados e apagados.
- **Criar espaço personalizado:** campos de nome, tipo (18 tipos, incluindo semirreboque de 4 eixos, reboques de 3 e 4 eixos, caminhão bitruck de 4 eixos e cavalo mecânico de 4 eixos em duas versões: 2 + 2 e 1 + 3), comprimento, largura e altura internos, carga máxima e bitola.
  - Cada eixo (A–E) tem distância, tara e carga máxima. No bitruck e no cavalo 8×4 (2 + 2), A e B formam o par dianteiro direcional, que divide a carga como o grupo traseiro. No cavalo 1 + 3, B, C e D formam o grupo traseiro.
  - Referência das distâncias (o 0): o prato no cavalo; a parede da frente do espaço de carga nos demais. No caminhão, o eixo dianteiro fica à frente do baú e a distância é negativa. A explicação, com um exemplo, aparece acima dos campos dos eixos.
  - Uma vista lateral em escala, com o mesmo veículo 3D do plano de carga (cabine, rodas nos eixos, baú, cambão, pino-rei e pés de apoio), mostra as cotas com os valores e o sinal (A = −1 300), marca onde fica o 0 e acompanha os valores enquanto você digita. Um eixo em posição impossível fica vermelho, com o motivo logo abaixo do desenho. Os campos ainda vazios usam os valores do exemplo. Sem WebGL, aparece um esquema simples com as mesmas cotas.
  - As distâncias medem-se a partir da parede frontal do espaço de carga; nos cavalos, a partir do prato.
  - **Limites opcionais:** carga máxima do conjunto dianteiro e do traseiro (quando o conjunto tem mais de um eixo), peso bruto máximo (PBT; no semirreboque, PBTC da combinação; no cavalo, CMT/PBTC) e a **repartição** de cada eixo no seu conjunto, em % (vazio = igual; preenchida, tem de somar 100%). O catálogo já traz os limites usuais: conjunto duplo 17 000 kg, triplo 25 500 kg, PBT dos caminhões rígidos.
- **Peso por eixo:** cada eixo mostra a carga mais a tara, a carga máxima e a divisão entre rodas esquerdas e direitas, calculada pela bitola e pelo desvio lateral do centro de gravidade. Os conjuntos aparecem com a sua carga e limite, e a linha de baixo traz o peso bruto.

Os espaços personalizados, as edições e os favoritos ficam guardados no navegador.

O código está em `src/spaces.js` (dados, validação e cálculo de eixos, sem DOM) e `src/spaces-ui.js` (telas).

## Como o plano é montado

O código está em `src/loadplan.js` (sem DOM). O problema é o carregamento de contêiner 3D com limite de peso por eixo, resolvido em três partes.

1. **Arranjo (heurística construtiva por espaços maximais).**
   - **Lista de espaços vazios:** o sistema mantém a lista dos maiores espaços vazios. Cada volume colocado recorta todos os espaços que toca.
   - **Escolha da posição:** o volume vai para a posição mais à frente, mais baixa e que deixa a carga mais equilibrada entre esquerda e direita.
   - **Cantos do fundo:** também são testados, para quando os eixos pedem a carga mais para trás.
   - **Regras checadas em cada posição:**
     - cabe e não sobrepõe outro volume;
     - apoio mínimo da base (padrão 80%);
     - rotações permitidas: "em pé" só gira no plano do chão; "deitar" permite as 6 posições;
     - nada em cima de volume frágil;
     - peso máximo em cima de cada volume, somado pela pilha inteira;
     - ordem de descarga: um volume não pode ficar entre outro que sai antes e as portas, nem em cima dele;
     - **peso por eixo:** nenhum eixo, conjunto, prato ou o peso bruto passa do limite.
   - **Volume deixado de fora:** a mensagem diz o motivo: peso, eixo, regras ou falta de espaço.
2. **Verificação (estática).**
   - **Cálculo:** equilíbrio de momentos a partir do centro de gravidade de cada volume, como descrito em `spaces.js`. Inclui a repartição `kᵢ` de cada conjunto e a passagem do pino-rei para os eixos do cavalo.
   - **Quando roda:** com o plano na saída e de novo **depois de cada entrega**.
   - **Avisos de limite:** eixo, conjunto, pino-rei, peso bruto e eixo que levanta.
   - **Avisos de distribuição:**
     - desbalanceamento lateral (padrão: até 60% de um lado);
     - pouca carga no eixo dianteiro (padrão: mínimo de 20% do peso do caminhão ou cavalo);
     - pouca carga no eixo de tração (padrão: mínimo de 20% do peso bruto).
   - **Comparação:** feita em gramas inteiros, para um valor igual ao limite nunca aparecer como excedido.
3. **Busca (meta-heurística tipo GRASP).**
   - **Primeiro plano:** sai na hora.
   - **Novas tentativas:** a montagem é refeita com ordens de volumes sorteadas, dentro de um tempo configurável (padrão 2 s, até 3 000 tentativas). Fica o plano com a melhor pontuação: volume carregado menos penalidades por excesso em eixo e por avisos.
   - **Repetibilidade:** o sorteio usa uma semente tirada da própria lista, então a mesma lista dá o mesmo plano.
   - **Interrupção:** qualquer edição interrompe a busca e começa outra.
   - **Ajuste longitudinal:** se ainda sobrar um problema, a carga inteira pode recuar no baú. Sem problema, ela fica encostada na parede da frente.

**Entregas.** Os destinos da lista são as paradas, na ordem mostrada ("Entrega 1, 2…"), que se muda com ↑ e ↓. A última entrega é carregada primeiro e vai para a frente. Ao empurrar volumes para trás por causa dos eixos, o sistema reserva no fundo o comprimento de que as entregas anteriores precisam. O painel de peso por eixo mostra a lista de problemas e uma tabela com o uso de cada eixo na saída e depois de cada entrega.

**Regras do plano.** Ficam no painel à esquerda: apoio mínimo, desbalanceamento lateral máximo, carga mínima no eixo dianteiro e no de tração, e tempo de otimização. Cada volume tem as suas regras no formulário: posição (em pé ou deitar), peso máximo em cima (vazio = sem limite, 0 = não empilhar) e frágil.

## Importar volumes de uma planilha

O botão **Importar planilha** lê um arquivo Excel (`.xlsx`) ou CSV e acrescenta os volumes à lista. O link **Baixar modelo CSV**, abaixo do formulário, baixa um modelo pronto.

- **Colunas:** são reconhecidas pelo cabeçalho, com ou sem acentos e em português ou inglês: Descrição, Comprimento, Largura, Altura, Peso, Quantidade, Destino e Cor, e, se quiser, Pode deitar (Sim/Não), Frágil (Sim/Não) e Peso máx. em cima (kg). Sem cabeçalho, a ordem esperada é essa mesma.
- **Unidades:** as medidas são em mm, a menos que o cabeçalho diga `(cm)` ou `(m)`. O peso é em kg por unidade; um cabeçalho "Peso total" é dividido pela quantidade.
- **CSV:** aceita `;`, `,` ou tab como separador, vírgula decimal e arquivos em UTF-8 ou Windows-1252, que é como o Excel salva no Brasil.
- **Excel:** só a primeira folha é lida. Arquivos `.xls` antigos não são suportados: salve como `.xlsx` ou `.csv`.
- **Linhas inválidas** (sem medidas ou que não cabem no veículo escolhido) são ignoradas, e a mensagem indica o número de cada uma.

---

Desenvolvido por Gustavo F. Landal - 2026 - gustavoflandal@gmail.com
