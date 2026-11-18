# Syncrofin 3D Planner

Planejador de carga 3D para vans, caminhões, carretas e contêineres, que roda no navegador. Você monta a lista de carga, escolhe o veículo e o app posiciona os volumes automaticamente. Ele mostra a ocupação de volume, peso, piso e metros lineares, além da distribuição de peso por eixo e do centro de gravidade.

## Requisitos

- Node.js 18 ou superior para o build (sem dependências do npm)

## Vista 3D

A vista 3D usa WebGL com o [Three.js](https://threejs.org) r170 (licença MIT), que vem incluído no projeto em `src/vendor/`, então não depende de CDN. O código está em `src/scene3d.js`. A cena mostra:

- caixas de papelão com o nome do item impresso, o símbolo "este lado para cima", arestas escuras e sombras suaves;
- espaço de carga aberto para quem olha, com piso de chapa xadrez: paredes onduladas no contêiner e painéis brancos de baú nos caminhões, reboques e semirreboques;
- o veículo montado a partir dos dados do espaço de carga: rodas nas distâncias dos eixos e na bitola (pneus arredondados, aros com porcas), cavalo mecânico com prato, tanque de combustível, pés de apoio do semirreboque, cambão do reboque, protetores laterais e para-choque traseiro;
- cabine prata de teto alto, no estilo de um cavalo europeu moderno: para-brisa inclinado, quebra-sol, grade com frisos, faróis no para-choque, janelas, retrovisores, entradas de ar, degraus e caixas de roda recortadas sobre os eixos dianteiros. A mesma cabine serve ao caminhão rígido, ajustada à altura do baú.
- vans e furgões inteiriços, brancos: capô curto, para-brisa inclinado até o teto, janelas das portas, faróis, grade, para-choques, retrovisores, assoalho baixo, rodas menores e caixas de roda recortadas na lateral (a traseira sobe sobre a roda quando ela passa da altura do assoalho).

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

Os planos ficam salvos apenas no navegador (localStorage).

## Espaços de carga

O espaço de carga é o veículo ou contêiner onde a carga é posicionada.

- **Painel do espaço:** fica sobre a vista 3D e mostra o espaço escolhido com as dimensões internas. Uma linha traz a capacidade (peso, volume e metros livres) e outra o que a lista de carga pede; o valor fica em vermelho quando passa da capacidade.
- **Lista de espaços:** a seta ▾ do painel abre a lista. Dá para filtrar por tipo (contêineres, vans e furgões, caminhões, reboques) e marcar favoritos com ★. Ao escolher um semirreboque, aparece a lista de **cavalos mecânicos**.
  - Com cavalo, a carga no pino-rei é repartida pelos eixos do cavalo.
  - Sem cavalo, só a carga no pino-rei é calculada.
- **Aba "Espaços de carga":** tabela de todos os espaços, com filtro por favorito, nome, tipo, origem e data de criação, ordenação por coluna e paginação.
  - Os espaços **padrão** podem ser editados e restaurados.
  - Os **personalizados** podem ser editados e apagados.
- **Criar espaço personalizado:** campos de nome, tipo (19 tipos, incluindo van / furgão, semirreboque de 4 eixos, reboques de 3 e 4 eixos, caminhão bitruck de 4 eixos e cavalo mecânico de 4 eixos em duas versões: 2 + 2 e 1 + 3), comprimento, largura e altura internos, carga máxima e bitola.
  - Cada eixo (A–E) tem distância, tara e carga máxima. No bitruck e no cavalo 8×4 (2 + 2), A e B formam o par dianteiro direcional, que divide a carga como o grupo traseiro. No cavalo 1 + 3, B, C e D formam o grupo traseiro.
  - Referência das distâncias (o 0): o prato no cavalo; a parede da frente do espaço de carga nos demais. No caminhão, o eixo dianteiro fica à frente do baú e a distância é negativa. A explicação, com um exemplo, aparece acima dos campos dos eixos.
  - Uma vista lateral em escala, com o mesmo veículo 3D do plano de carga (cabine, rodas nos eixos, baú, cambão, pino-rei e pés de apoio), mostra as cotas com os valores e o sinal (A = −1 300), marca onde fica o 0 e acompanha os valores enquanto você digita. Um eixo em posição impossível fica vermelho, com o motivo logo abaixo do desenho. Os campos ainda vazios usam os valores do exemplo. Sem WebGL, aparece um esquema simples com as mesmas cotas.
  - As distâncias medem-se a partir da parede frontal do espaço de carga; nos cavalos, a partir do prato.
  - **Limites opcionais:** carga máxima do conjunto dianteiro e do traseiro (quando o conjunto tem mais de um eixo), peso bruto máximo (PBT; no semirreboque, PBTC da combinação; no cavalo, CMT/PBTC) e a **repartição** de cada eixo no seu conjunto, em % (vazio = igual; preenchida, precisa somar 100%). O catálogo já traz os limites usuais: conjunto duplo 17 000 kg, triplo 25 500 kg, PBT dos caminhões rígidos.
- **Vans e furgões no catálogo:** minifurgão 650 kg (porte Fiat Fiorino, para entregas urbanas), furgão compacto 800 kg, van média 1,2 t, van grande teto alto 1,4 t e van extralonga 3,5 t. As medidas, taras e limites são típicos da categoria: confira com o documento do veículo e ajuste no cadastro.
- **Peso por eixo:** com WebGL, o painel mostra o veículo 3D de lado, com a carga à vista pela lateral aberta; uma seta grande desce sobre cada eixo (o comprimento é a fração do limite usada e a cor é o estado: verde, amarelo ou vermelho), a carga em kg aparece sob a roda e uma seta azul fina marca o centro de gravidade. Em telas estreitas os valores passam a toneladas e os eixos próximos ganham duas linhas de rótulos. Sem WebGL fica o esquema 2D. Cada eixo mostra a carga mais a tara, a carga máxima e a divisão entre rodas esquerdas e direitas, calculada pela bitola e pelo desvio lateral do centro de gravidade. Os conjuntos aparecem com a sua carga e limite, e a linha de baixo traz o peso bruto.

Os espaços personalizados, as edições e os favoritos ficam salvos no navegador.

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

**Modos de planejamento.** Em **Planejar a carga**, no painel à esquerda, você escolhe como o destino (cliente) de cada volume entra no plano. O modo fica salvo com o plano.

- **Normal:** o destino é ignorado. Todos os volumes se misturam e o plano busca só o melhor aproveitamento de espaço e peso, dentro dos limites dos eixos e das regras do plano. Os eixos são verificados na saída.
- **Por cliente:** a carga de cada cliente forma um bloco só, sem volume de outro cliente na frente dela (do lado das portas) nem em cima, em nenhum sentido. A ordem dos blocos não é fixa: a otimização testa ordens diferentes (a da lista, o cliente mais pesado na frente, o mais leve na frente e ordens sorteadas) e fica com a que melhor aproveita o espaço, o peso e os eixos. A lista mostra o bloco escolhido para cada cliente ("Bloco 1 (frente)", "Bloco 2"…). Os eixos são verificados na saída.
- **Por itinerário** (padrão): segue a ordem de entrega descrita abaixo, com verificação dos eixos depois de cada entrega.

**Ajuste manual.** Os botões **Automático** e **Manual** ficam na barra da vista, ao lado de 3D/Topo/Lado.

- **Automático** (padrão): o planejador arruma a carga e busca planos melhores a cada mudança.
- **Manual:** o plano fica como está e o operador move os volumes. Arraste um volume com o mouse (ou o dedo): uma prévia verde mostra onde ele vai ficar, ou vermelha quando não cabe (passaria do teto). Ao soltar, o volume desliza no piso, encosta numa parede ou num volume vizinho quando chega a menos de 6 cm e assenta pela gravidade, no piso ou sobre os volumes embaixo; o que estava em cima dele desce. Arrastar o fundo continua girando a vista.
- **Teclado:** clique num volume (contorno âmbar) e use as setas para movê-lo 100 mm (10 mm com Shift) e **R** para girá-lo 90°. Esc tira a seleção.
- **Regras:** posições feitas à mão nunca deixam volumes sobrepostos ou fora do baú, mas o que quebra uma regra do plano é mostrado como aviso, e não recusado: base pouco apoiada, carga sobre um frágil, peso acima do limite "em cima", volume no caminho de uma entrega anterior ou misturado com o bloco de outro cliente. Os eixos são recalculados a cada movimento.
- **Lista no modo manual:** ao acrescentar ou tirar itens, trocar o veículo ou as regras, os volumes já posicionados ficam onde estão e os que faltam são encaixados no espaço livre em volta deles. **Carregar** faz o mesmo com os volumes que ficaram de fora.
- Voltar ao **Automático** refaz o plano (com confirmação se houve ajustes). O modo e as posições manuais ficam salvos com o plano. O ajuste manual usa a vista 3D (WebGL).

**Ordem de carregamento (PDF).** O botão **Ordem de carregamento (PDF)**, ao lado de Relatório, gera um documento para quem carrega o veículo e o abre numa nova aba, pronto para imprimir ou salvar. Se o navegador bloquear a aba, o arquivo é baixado.

- **Sequência:** sempre do **fundo** (a parede junto à cabine) para as **portas**. Um volume só entra depois dos volumes que ficam embaixo dele; entre os liberados vai primeiro o mais ao fundo, depois o mais baixo, depois o da esquerda. A sequência é dividida em etapas de cerca de 1,25 m do comprimento (no máximo 12 volumes por etapa).
- **Capa:** veículo, data, a regra de carregamento, totais (volumes, peso, m³, comprimento usado, etapas, modo de planejamento), imagem 3D da carga completa, carga por eixo na saída e os avisos do plano (inclusive volumes que ficaram de fora).
- **Cada etapa:** imagem 3D vista das portas, com o que já foi carregado e os volumes da etapa destacados em laranja; planta (de cima) e vista lateral em escala, com os já carregados em cinza e os da etapa coloridos e numerados; tabela com nº, volume, cliente, medidas, peso, distância do fundo, altura, lado (esquerdo, centro, direito) e observações (girado, deitado, frágil, não empilhar).
- No fim, campos de assinatura para o responsável pelo carregamento e o conferente; todas as páginas trazem "Página X de N".
- O PDF é gerado no próprio navegador por `src/pdfwriter.js` (sem bibliotecas), e o documento é montado por `src/loaddoc.js`. Sem WebGL, o documento sai sem as imagens 3D, com as plantas, as vistas laterais e as tabelas.

**Entregas (modo por itinerário).** Os destinos da lista são as paradas, na ordem mostrada ("Entrega 1, 2…"), que se muda com ↑ e ↓. A última entrega é carregada primeiro e vai para a frente. Ao empurrar volumes para trás por causa dos eixos, o sistema reserva no fundo o comprimento de que as entregas anteriores precisam. O painel de peso por eixo mostra a lista de problemas e uma tabela com o uso de cada eixo na saída e depois de cada entrega.

**Regras do plano.** Ficam no painel à esquerda: apoio mínimo, desbalanceamento lateral máximo, carga mínima no eixo dianteiro e no de tração, e tempo de otimização. Cada volume tem as suas regras no formulário: posição (em pé ou deitar), peso máximo em cima (vazio = sem limite, 0 = não empilhar) e frágil.

## Importar volumes de uma planilha

O botão **Importar planilha** lê um arquivo Excel (`.xlsx`) ou CSV e acrescenta os volumes à lista. O link **Baixar modelo CSV**, abaixo do formulário, baixa um modelo pronto.

- **Colunas:** são reconhecidas pelo cabeçalho, com ou sem acentos e em português ou inglês: Descrição, Comprimento, Largura, Altura, Peso, Quantidade, Destino e Cor, e, se quiser, Pode deitar (Sim/Não), Frágil (Sim/Não) e Peso máx. em cima (kg). Sem cabeçalho, a ordem esperada é essa mesma.
- **Cores:** 22 cores — Azul, Amarelo, Verde, Laranja, Cinza, Vermelho, Rosa, Roxo, Lilás, Azul-escuro, Verde-água, Ciano, Verde-limão, Verde-escuro, Oliva, Marrom, Bege, Salmão, Dourado, Vinho, Grafite e Branco (também em inglês e variações como "azul marinho", "turquesa", "bordô", "preto"). Linhas sem cor recebem as cores em sequência. Nas caixas de cor escura, o nome é impresso em branco.
- **Unidades:** as medidas são em mm, a menos que o cabeçalho diga `(cm)` ou `(m)`. O peso é em kg por unidade; um cabeçalho "Peso total" é dividido pela quantidade.
- **CSV:** aceita `;`, `,` ou tab como separador, vírgula decimal e arquivos em UTF-8 ou Windows-1252, que é como o Excel salva no Brasil.
- **Excel:** só a primeira aba é lida. Arquivos `.xls` antigos não são suportados: salve como `.xlsx` ou `.csv`.
- **Linhas inválidas** (sem medidas ou que não cabem no veículo escolhido) são ignoradas, e a mensagem indica o número de cada uma.

---

Desenvolvido por Gustavo F. Landal - 2026 - gustavoflandal@gmail.com
