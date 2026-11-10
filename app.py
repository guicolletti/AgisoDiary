"""
Diário de Bordo do Agisö.

Como rodar (no terminal, dentro da pasta do projeto):
    .venv\\Scripts\\python -m pip install -r requirements.txt
    .venv\\Scripts\\python app.py
Depois abra http://127.0.0.1:5000

Escrever no site:
  - Rodando no seu computador, o botão "Escrever" aparece sozinho (só para você).
  - Ao publicar na internet, defina uma senha antes de iniciar o servidor:
        PowerShell:   $env:EDIT_PASSWORD = "uma-senha-boa"
        Linux/macOS:  export EDIT_PASSWORD="uma-senha-boa"
    Com a senha definida, só quem entrar com ela consegue editar.

O conteúdo fica em data/diario.json. Cada salvamento guarda uma cópia
de segurança em data/backups/.
"""
import json
import os
import re
import secrets
import shutil
import threading
import time
import uuid
from datetime import datetime
from functools import wraps
from hmac import compare_digest
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, render_template, request, session

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_FILE = DATA_DIR / "diario.json"
BACKUP_DIR = DATA_DIR / "backups"
FOTOS_DIR = BASE_DIR / "static" / "fotos"
EDIT_PASSWORD = os.environ.get("EDIT_PASSWORD", "")
MAX_BACKUPS = 40

app = Flask(__name__)


def _versao_estaticos():
    """Número que muda quando qualquer CSS/JS/imagem do site muda.

    É colocado como ?v=... nos links, para o navegador (e o cache do Render)
    buscarem os arquivos novos a cada deploy, em vez de usar cópias antigas."""
    maior = 0
    for pasta in ("css", "js", "img"):
        base = Path(app.static_folder) / pasta
        if base.is_dir():
            for arq in base.iterdir():
                try:
                    maior = max(maior, int(arq.stat().st_mtime))
                except OSError:
                    pass
    return maior


@app.context_processor
def _injetar_versao():
    return {"v": _versao_estaticos()}


@app.after_request
def _cache(resp):
    # a página em si nunca fica em cache; os estáticos têm ?v=, então podem
    if resp.mimetype == "text/html" or request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp
app.json.ensure_ascii = False  # mantém o "ö" e os acentos legíveis no JSON
app.config.update(
    TEMPLATES_AUTO_RELOAD=True,
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,   # fotos de até 8 MB
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)


def _chave_secreta():
    """Chave das sessões: variável de ambiente ou um arquivo gerado na primeira execução."""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    arquivo = DATA_DIR / ".secret_key"
    if not arquivo.exists():
        DATA_DIR.mkdir(exist_ok=True)
        arquivo.write_text(secrets.token_hex(32))
    return arquivo.read_text().strip()


app.secret_key = _chave_secreta()
_trava = threading.Lock()


# ---------------------------------------------------------------------------
# Quem pode editar
# ---------------------------------------------------------------------------

def _acesso_local():
    """True só quando o pedido vem do próprio computador, sem proxy no meio."""
    if request.headers.get("X-Forwarded-For") or request.headers.get("Forwarded"):
        return False
    return request.remote_addr in ("127.0.0.1", "::1")


def edicao_disponivel():
    return bool(EDIT_PASSWORD) or _acesso_local()


def pode_editar():
    if EDIT_PASSWORD:
        return bool(session.get("editor"))
    return _acesso_local()


def _origem_valida():
    """Barra pedidos feitos por outros sites: exige o cabeçalho próprio e, se houver, a mesma origem."""
    if request.headers.get("X-Requested-With") != "agiso":
        return False
    origem = request.headers.get("Origin")
    return not origem or urlparse(origem).netloc == request.host


def erro(mensagem, codigo):
    return jsonify(erro=mensagem), codigo


def exige_edicao(funcao):
    @wraps(funcao)
    def interna(*args, **kwargs):
        if not _origem_valida():
            return erro("Pedido recusado.", 403)
        if not pode_editar():
            return erro("Você precisa entrar para editar.", 401)
        return funcao(*args, **kwargs)
    return interna


# ---------------------------------------------------------------------------
# Leitura, validação e gravação do diário
# ---------------------------------------------------------------------------

PADRAO = {
    "titulo": "Diário de Bordo",
    "dono": "Agisö",
    "subtitulo": "",
    "ex_libris": "",
    "fim": "",
    "entradas": [],
}
MOLDURAS = ("fita", "polaroid", "postit", "cantos", "recorte", "lapis")
RE_FOTO = re.compile(r"^fotos/[A-Za-z0-9_.-]{1,100}\.(png|jpe?g|gif|webp)$", re.I)
RE_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def novo_id():
    return uuid.uuid4().hex[:10]


def carregar_diario():
    """Lê o diário do disco a cada requisição: basta salvar o JSON e recarregar a página."""
    try:
        with DATA_FILE.open(encoding="utf-8") as f:
            dados = json.load(f)
    except FileNotFoundError:
        abort(500, description=f"Arquivo do diário não encontrado: {DATA_FILE}")
    except json.JSONDecodeError as e:
        abort(
            500,
            description=(
                f"O arquivo data/diario.json tem um erro na linha {e.lineno}, "
                f"coluna {e.colno}: {e.msg}. Confira vírgulas e aspas."
            ),
        )
    diario = {**PADRAO, **{k: v for k, v in dados.items() if k in PADRAO}}
    ids = set()
    for entrada in diario["entradas"]:
        if not isinstance(entrada.get("id"), str) or entrada["id"] in ids:
            entrada["id"] = novo_id()
        ids.add(entrada["id"])
    return diario


def _texto(valor, maximo, campo, uma_linha=True):
    if valor is None:
        return ""
    if not isinstance(valor, str):
        raise ValueError(f"O campo “{campo}” precisa ser um texto.")
    valor = valor.replace("\r\n", "\n").replace("\r", "\n")
    valor = re.sub(r"\s*\n\s*", " ", valor) if uma_linha else valor
    valor = valor.strip()
    if len(valor) > maximo:
        raise ValueError(f"O campo “{campo}” passou de {maximo} caracteres.")
    return valor


def limpar_diario(carga):
    if not isinstance(carga, dict):
        raise ValueError("Formato inválido.")
    saida = {
        "titulo": _texto(carga.get("titulo"), 120, "Título do diário") or PADRAO["titulo"],
        "dono": _texto(carga.get("dono"), 60, "Nome do dono") or PADRAO["dono"],
        "subtitulo": _texto(carga.get("subtitulo"), 300, "Subtítulo"),
        "ex_libris": _texto(carga.get("ex_libris"), 600, "Texto da etiqueta", uma_linha=False),
        "fim": _texto(carga.get("fim"), 300, "Texto do fim"),
        "entradas": [],
    }
    entradas = carga.get("entradas", [])
    if not isinstance(entradas, list) or len(entradas) > 400:
        raise ValueError("Lista de entradas inválida (máximo de 400).")

    ids = set()
    for n, e in enumerate(entradas, 1):
        if not isinstance(e, dict):
            raise ValueError(f"A entrada {n} está num formato inválido.")
        rotulo = f"entrada {n}"
        eid = e.get("id") if isinstance(e.get("id"), str) and RE_ID.match(e["id"]) else novo_id()
        while eid in ids:
            eid = novo_id()
        ids.add(eid)

        blocos = []
        paragrafos = e.get("paragrafos", [])
        if not isinstance(paragrafos, list) or len(paragrafos) > 100:
            raise ValueError(f"Parágrafos inválidos na {rotulo}.")
        for b in paragrafos:
            if isinstance(b, str):
                blocos.append(_texto(b, 8000, f"Parágrafo ({rotulo})", uma_linha=False))
            elif isinstance(b, dict) and "imagem" in b:
                imagem = b.get("imagem")
                if not isinstance(imagem, str) or not RE_FOTO.match(imagem):
                    raise ValueError(f"Foto inválida na {rotulo}. Use as fotos enviadas pelo editor.")
                moldura = b.get("moldura")
                blocos.append({
                    "imagem": imagem,
                    "legenda": _texto(b.get("legenda"), 160, f"Legenda ({rotulo})"),
                    "moldura": moldura if moldura in MOLDURAS else "fita",
                })
            else:
                raise ValueError(f"Bloco desconhecido na {rotulo}.")

        entrada = {
            "id": eid,
            "data": _texto(e.get("data"), 40, f"Data ({rotulo})"),
            "titulo": _texto(e.get("titulo"), 200, f"Título ({rotulo})"),
            "local": _texto(e.get("local"), 80, f"Local ({rotulo})"),
            "paragrafos": blocos,
        }
        nota = _texto(e.get("nota"), 800, f"Nota ({rotulo})", uma_linha=False)
        if nota:
            entrada["nota"] = nota
        if e.get("nova_pagina") is True:
            entrada["nova_pagina"] = True
        saida["entradas"].append(entrada)
    return saida


def salvar_diario(diario):
    """Grava com segurança: copia o arquivo atual para data/backups/ e troca o arquivo de uma vez."""
    with _trava:
        DATA_DIR.mkdir(exist_ok=True)
        if DATA_FILE.exists():
            BACKUP_DIR.mkdir(exist_ok=True)
            carimbo = datetime.now().strftime("%Y%m%d-%H%M%S")
            shutil.copy2(DATA_FILE, BACKUP_DIR / f"diario-{carimbo}.json")
            antigos = sorted(BACKUP_DIR.glob("diario-*.json"))[:-MAX_BACKUPS]
            for arquivo in antigos:
                arquivo.unlink(missing_ok=True)
        temporario = DATA_FILE.with_suffix(".tmp")
        temporario.write_text(json.dumps(diario, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporario, DATA_FILE)


# ---------------------------------------------------------------------------
# Páginas e API
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template(
        "index.html",
        diario=carregar_diario(),
        editor={
            "disponivel": edicao_disponivel(),
            "precisa_senha": bool(EDIT_PASSWORD),
            "logado": pode_editar(),
        },
    )


@app.get("/api/diario")
def api_diario():
    return jsonify(carregar_diario())


@app.put("/api/diario")
@exige_edicao
def api_salvar():
    try:
        diario = limpar_diario(request.get_json(silent=True))
    except ValueError as e:
        return erro(str(e), 400)
    salvar_diario(diario)
    return jsonify(diario)


def _tipo_da_imagem(inicio):
    if inicio.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if inicio.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if inicio.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if inicio[:4] == b"RIFF" and inicio[8:12] == b"WEBP":
        return "webp"
    return None


@app.post("/api/foto")
@exige_edicao
def api_foto():
    arquivo = request.files.get("foto")
    if not arquivo:
        return erro("Nenhuma foto enviada.", 400)
    tipo = _tipo_da_imagem(arquivo.stream.read(16))
    arquivo.stream.seek(0)
    if not tipo:
        return erro("Formato não aceito. Use PNG, JPG, GIF ou WebP.", 400)
    FOTOS_DIR.mkdir(parents=True, exist_ok=True)
    nome = f"{uuid.uuid4().hex[:12]}.{tipo}"
    arquivo.save(FOTOS_DIR / nome)
    return jsonify(caminho=f"fotos/{nome}")


@app.post("/api/entrar")
def api_entrar():
    if not _origem_valida():
        return erro("Pedido recusado.", 403)
    if not EDIT_PASSWORD:
        return erro("Nenhuma senha foi definida no servidor.", 400)
    senha = (request.get_json(silent=True) or {}).get("senha", "")
    if isinstance(senha, str) and compare_digest(senha.encode(), EDIT_PASSWORD.encode()):
        session["editor"] = True
        return jsonify(ok=True)
    time.sleep(1)  # desencoraja tentativas em série
    return erro("Senha incorreta.", 401)


@app.post("/api/sair")
def api_sair():
    if not _origem_valida():
        return erro("Pedido recusado.", 403)
    session.pop("editor", None)
    return jsonify(ok=True)


@app.errorhandler(413)
def arquivo_grande(_):
    return erro("A foto passou de 8 MB.", 413)


if __name__ == "__main__":
    app.run(debug=True)
