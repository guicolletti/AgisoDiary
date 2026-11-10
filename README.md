# Diário de Bordo do Agisö

Site em Flask: um diário de capa de couro com páginas envelhecidas, duas páginas por vez e animação de virar a página.

## Rodar

No terminal, dentro desta pasta (PowerShell ou Prompt de Comando):

```
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py
```

Abra http://127.0.0.1:5000 no navegador.

## Escrever direto no site

Clique em **Escrever** na barra de baixo. Abre um painel ao lado do livro onde você:

- cria, move (↑ ↓) e apaga entradas;
- escreve os parágrafos, adiciona fotos (enviadas do seu computador) e a nota a lápis;
- edita os textos da capa na aba **Capa e textos**.

O livro se refaz enquanto você digita. Clique em **Salvar** (ou Ctrl+S) para gravar em `data/diario.json`. Antes de cada gravação o site guarda uma cópia em `data/backups/` (as 40 mais recentes).

Quem pode escrever:

- por padrão, só quem abre o site no próprio computador (`127.0.0.1`). O botão nem aparece para os outros;
- para publicar o site e ainda escrever nele, defina uma senha antes de rodar: `set EDIT_PASSWORD=sua-senha` (PowerShell: `$env:EDIT_PASSWORD="sua-senha"`). Aí o painel pede a senha.

Se preferir, ainda dá para editar o `data/diario.json` à mão e recarregar (F5).

Formato do arquivo: cada item de `entradas` aceita:

| Campo | Para quê |
|---|---|
| `data` | O dia, em vermelho no topo (ex.: `"Dia 12"`) |
| `titulo` | Título da entrada |
| `local` | Coordenadas ou lugar, no canto direito (opcional) |
| `paragrafos` | Lista de parágrafos. Cada parágrafo é um texto entre aspas |
| `nota` | Anotação a lápis no fim da entrada (opcional) |
| `nova_pagina` | `true` faz a entrada começar numa página nova (opcional) |

Dentro dos textos:

- `*assim*` fica sublinhado em vermelho;
- `~~assim~~` fica riscado, como palavra cortada na escrita.

Para colar uma foto, use o botão **Adicionar foto** no painel (ou ponha o arquivo em `static/fotos/` e use um item assim dentro de `paragrafos`):

```json
{ "imagem": "fotos/minha-torre.png", "legenda": "A torre do posto", "moldura": "polaroid" }
```

A foto se ajusta sozinha ao tamanho da imagem (horizontal, vertical ou quadrada). `moldura` é opcional e pode ser:

| Valor | Aparência |
|---|---|
| `fita` | moldura de papel creme com fita adesiva (padrão) |
| `polaroid` | margem branca grossa, legenda escrita nela |
| `postit` | post-it amarelo, foto em grafite |
| `cantos` | presa por quatro cantoneiras escuras |
| `recorte` | papel rasgado, de borda irregular |
| `lapis` | foto em grafite com contorno riscado à mão |

A capa, a folha de rosto e a página de dentro da capa usam `dono`, `titulo`, `subtitulo`, `ex_libris` e `fim`, também em `data/diario.json`.

## Como usar o livro

- Clique na capa para abrir. Para virar a página, arraste-a com o mouse (ela dobra de verdade e volta se você soltar cedo), clique perto da borda ou use as setas do teclado.
- **Registros** abre um índice para pular direto para uma entrada.
- O endereço guarda a página (`#pagina-5`), então dá para enviar o link de uma página específica.
- No celular o livro mostra uma página por vez. Deslize para os lados para virar.

## Arquivos

```
app.py                  servidor Flask
data/diario.json        o conteúdo do diário
templates/index.html    capa, folha de rosto e estrutura da página
static/css/style.css    couro, papel, tipografia e animação
static/js/book.js       montagem das páginas e física da virada
static/js/editor.js     o painel "Escrever"
static/img/             texturas de couro, papel e mesa
tools/gen_textures.py   (opcional) gera as texturas de novo
```

## Fontes

As fontes (IM Fell English, Kalam e Reenie Beanie) vêm do Google Fonts e precisam de internet. Sem elas o site usa fontes parecidas que já existem no Windows (Segoe Print, Palatino), e tudo continua funcionando.
