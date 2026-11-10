"""
Gera as texturas do diário (couro, papel envelhecido e mesa).

Uso opcional (só se quiser mudar a aparência):
    pip install numpy pillow
    python tools/gen_textures.py

As imagens prontas já estão em static/img/, então o site funciona sem rodar isto.
Todas as texturas são "ladrilháveis": repetem sem emenda visível.
"""
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "static" / "img"
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(1608)


def spectral_noise(n, beta, aniso=(1.0, 1.0)):
    """Ruído fractal periódico (1/f^beta). aniso estica o ruído em x/y."""
    white = rng.standard_normal((n, n))
    spec = np.fft.fft2(white)
    fy = np.fft.fftfreq(n)[:, None] * aniso[1]
    fx = np.fft.fftfreq(n)[None, :] * aniso[0]
    r = np.sqrt(fx**2 + fy**2)
    r[0, 0] = 1
    spec *= 1.0 / r**beta
    spec[0, 0] = 0
    out = np.real(np.fft.ifft2(spec))
    return (out - out.mean()) / out.std()


def cellular(n, cells):
    """Ruído celular periódico: devolve (distância ao 1º vizinho, ao 2º)."""
    jitter = rng.random((cells, cells, 2))
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float64)
    gx, gy = xs / n * cells, ys / n * cells
    ci, cj = np.floor(gx).astype(int), np.floor(gy).astype(int)
    d1 = np.full((n, n), 9.0)
    d2 = np.full((n, n), 9.0)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            ni, nj = ci + di, cj + dj
            px = ni + jitter[nj % cells, ni % cells, 0]
            py = nj + jitter[nj % cells, ni % cells, 1]
            d = np.sqrt((gx - px) ** 2 + (gy - py) ** 2)
            closer = d < d1
            d2 = np.where(closer, d1, np.minimum(d2, d))
            d1 = np.where(closer, d, d1)
    return d1, d2


def shade(height, strength=2.2):
    """Iluminação simples a partir de um mapa de altura (luz no canto sup. esq.)."""
    gy, gx = np.gradient(height)
    nx, ny = -gx * strength, -gy * strength
    nz = np.ones_like(height)
    ln = np.sqrt(nx**2 + ny**2 + nz**2)
    lx, ly, lz = -0.5, -0.6, 0.62
    return (nx * lx + ny * ly + nz * lz) / ln / lz


def save(arr, name, quality=86):
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    img.save(OUT / name, quality=quality, optimize=True)
    print("ok", name, (OUT / name).stat().st_size // 1024, "KB")


# ---------------------------------------------------------------- couro
def leather(n=640):
    from scipy.ndimage import gaussian_filter
    # grão fino e irregular: duas camadas de células, com bordas suavizadas
    d1, d2 = cellular(n, 95)
    e1, e2 = cellular(n, 60)
    ridge = np.clip((d2 - d1) * 2.2, 0, 1)
    ridge2 = np.clip((e2 - e1) * 2.0, 0, 1)
    pebble = 0.65 * ridge**0.8 + 0.35 * ridge2**0.8 - 0.15 * d1
    pebble += spectral_noise(n, 0.9) * 0.10           # quebra a regularidade
    height = gaussian_filter(pebble, 0.9, mode="wrap")
    lit = shade(height, 3.2)
    lit = (lit - lit.mean()) / lit.std()

    mottle = spectral_noise(n, 2.3)                    # manchas largas
    wear = spectral_noise(n, 2.0)
    wear_mask = np.clip((wear - 1.0) * 1.1, 0, 1)      # áreas gastas/desbotadas

    base = np.array([68.0, 42.0, 25.0])
    light = 1.0 + 0.13 * lit + 0.07 * mottle
    img = base[None, None, :] * light[..., None]
    worn_col = np.array([128.0, 92.0, 60.0])
    img = img * (1 - 0.3 * wear_mask[..., None]) + worn_col * 0.3 * wear_mask[..., None] * (1 + 0.08 * lit[..., None])
    img *= (1 - 0.10 * (1 - ridge))[..., None]
    img += rng.standard_normal((n, n, 1)) * 2.2        # poro fino
    save(img, "leather.jpg", 88)


# ---------------------------------------------------------------- papel
def paper(n=900):
    big = spectral_noise(n, 2.4)
    mid = spectral_noise(n, 1.6)
    fine = spectral_noise(n, 0.7)
    fibres = spectral_noise(n, 1.2, aniso=(0.12, 1.0))   # fibras verticais
    fibres2 = spectral_noise(n, 1.2, aniso=(1.0, 0.12))  # fibras horizontais

    base = np.array([222.0, 201.0, 154.0])
    tone = 1.0 + 0.045 * big + 0.03 * mid + 0.02 * fine + 0.012 * (fibres + fibres2)
    img = base[None, None, :] * tone[..., None]

    # manchas de umidade (marrom) em áreas largas
    stain = np.clip((spectral_noise(n, 2.6) - 0.7) * 0.9, 0, 1)
    img = img * (1 - 0.30 * stain[..., None]) + np.array([150.0, 108.0, 56.0]) * 0.30 * stain[..., None]

    # pintinhas (foxing)
    spots = np.zeros((n, n))
    for _ in range(170):
        x, y = rng.integers(0, n, 2)
        r = rng.uniform(1.0, 3.6)
        yy, xx = np.ogrid[-6:7, -6:7]
        blob = np.exp(-(xx**2 + yy**2) / (2 * r * r)) * rng.uniform(0.25, 0.7)
        for oy in range(-6, 7):
            for ox in range(-6, 7):
                spots[(y + oy) % n, (x + ox) % n] = max(spots[(y + oy) % n, (x + ox) % n], blob[oy + 6, ox + 6])
    img = img * (1 - 0.55 * spots[..., None]) + np.array([112.0, 72.0, 34.0]) * 0.55 * spots[..., None]
    save(img, "paper.jpg", 84)


# ---------------------------------------------------------------- mesa
def table(n=900):
    grain = spectral_noise(n, 1.3, aniso=(0.05, 1.0))   # veios horizontais
    knots = spectral_noise(n, 2.2)
    fine = spectral_noise(n, 0.6)
    base = np.array([34.0, 22.0, 15.0])
    tone = 1.0 + 0.20 * grain + 0.10 * knots + 0.05 * fine
    img = base[None, None, :] * tone[..., None]
    save(img, "table.jpg", 82)


if __name__ == "__main__":
    leather()
    paper()
    table()
