#!/usr/bin/env python3
"""Génère les 12 SVG d'overlay du banc de diagnostic.
Usage : python generate_svg.py

Les SVG sont transparents : ils se superposent à la photo de fond (board.png
ou board-nolcd.png) définie dans diagnostic.html via CSS.
"""

import os

OUT_DIR = "images"
os.makedirs(OUT_DIR, exist_ok=True)

# ----------------------------------------------------------------------------
# Coordonnées de référence (image 928x624)
# ----------------------------------------------------------------------------
LCD_X, LCD_Y, LCD_W, LCD_H = 135, 118, 757, 250

LED_D1 = (768, 48)   # verte
LED_D2 = (828, 48)   # jaune

BTN_SW1 = (310, 548) # jaune
BTN_SW2 = (475, 548) # vert
BTN_SW3 = (635, 548) # bleu
POT_P1  = (808, 548)

# ----------------------------------------------------------------------------
# En-tête / définitions
# ----------------------------------------------------------------------------
def svg_open(extra_defs=""):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 928 624" '
        'width="928" height="624">\n'
        f'  <defs>{extra_defs}</defs>\n'
        '  <rect width="928" height="624" fill="none"/>\n'
    )

GRAD_Y = (
    '<radialGradient id="gY">'
    '<stop offset="0%" stop-color="#ffee00" stop-opacity="1.0"/>'
    '<stop offset="45%" stop-color="#ffd000" stop-opacity="0.75"/>'
    '<stop offset="100%" stop-color="#ffd000" stop-opacity="0"/>'
    '</radialGradient>'
)
GRAD_G = (
    '<radialGradient id="gG">'
    '<stop offset="0%" stop-color="#00ff44" stop-opacity="1.0"/>'
    '<stop offset="45%" stop-color="#00dd33" stop-opacity="0.75"/>'
    '<stop offset="100%" stop-color="#00dd33" stop-opacity="0"/>'
    '</radialGradient>'
)
GRAD_B = (
    '<radialGradient id="gB">'
    '<stop offset="0%" stop-color="#66aaff" stop-opacity="1.0"/>'
    '<stop offset="45%" stop-color="#3388ff" stop-opacity="0.75"/>'
    '<stop offset="100%" stop-color="#3388ff" stop-opacity="0"/>'
    '</radialGradient>'
)

# ----------------------------------------------------------------------------
# Textes affichés sur le LCD
# ----------------------------------------------------------------------------
LCD_TEXT = (
    f'<text x="{LCD_X + LCD_W//2}" y="{LCD_Y + 130}" '
    'font-family="monospace" font-size="46" font-weight="bold" '
    'fill="#1a1a1a" text-anchor="middle" letter-spacing="2">IUT de Cachan</text>\n'
    f'  <text x="{LCD_X + LCD_W//2}" y="{LCD_Y + 200}" '
    'font-family="monospace" font-size="46" font-weight="bold" '
    'fill="#1a1a1a" text-anchor="middle" letter-spacing="2">XXXXXXXXXXXX</text>'
)

# ----------------------------------------------------------------------------
# Fonds colorés du LCD selon le type d'écran
# ----------------------------------------------------------------------------
def lcd_tint_yellow():   # RGB jaune
    return (f'<rect x="{LCD_X}" y="{LCD_Y}" width="{LCD_W}" height="{LCD_H}" '
            'fill="#ffcc00" opacity="0.55"/>')

def lcd_tint_green():
    return (f'<rect x="{LCD_X}" y="{LCD_Y}" width="{LCD_W}" height="{LCD_H}" '
            'fill="#00cc00" opacity="0.55"/>')

def lcd_tint_blue():
    return (f'<rect x="{LCD_X}" y="{LCD_Y}" width="{LCD_W}" height="{LCD_H}" '
            'fill="#0066ff" opacity="0.60"/>')

def lcd_tint_white():
    return (f'<rect x="{LCD_X}" y="{LCD_Y}" width="{LCD_W}" height="{LCD_H}" '
            'fill="#ffffff" opacity="0.60"/>')

def lcd_tint_mono():     # L1 : LCD monochrome à rétroéclairage jaune
    return (f'<rect x="{LCD_X}" y="{LCD_Y}" width="{LCD_W}" height="{LCD_H}" '
            'fill="#e6dd44" opacity="0.65"/>')

def lcd_none():
    """Pour L0 : la photo de fond (board-nolcd.png) montre déjà l'absence
    d'écran. On ajoute seulement une légende discrète pour confirmation."""
    return (
        f'<text x="{LCD_X + LCD_W//2}" y="{LCD_Y + LCD_H//2 + 10}" '
        'font-family="sans-serif" font-size="30" font-weight="bold" '
        'fill="#ffc107" text-anchor="middle" stroke="#000000" stroke-width="0.8">'
        'Emplacement écran vide (normal)</text>'
    )

# ----------------------------------------------------------------------------
# Halos LEDs
# ----------------------------------------------------------------------------
def led_halo(cx, cy, kind):
    grad = {"y": "gY", "g": "gG"}[kind]
    ring = {"y": "#ffee00", "g": "#00ff44"}[kind]
    return (
        f'<circle cx="{cx}" cy="{cy}" r="52" fill="url(#{grad})"/>\n'
        f'  <circle cx="{cx}" cy="{cy}" r="30" fill="none" stroke="{ring}" '
        'stroke-width="5" opacity="0.95"/>'
    )

# ----------------------------------------------------------------------------
# Halos boutons
# ----------------------------------------------------------------------------
def button_halo(cx, cy, kind):
    grad, ring = {
        "y": ("gY", "#ffee00"),
        "g": ("gG", "#00ff44"),
        "b": ("gB", "#66aaff"),
    }[kind]

    return (
        f'<circle cx="{cx}" cy="{cy}" r="100" fill="url(#{grad})"/>\n'
        f'  <circle cx="{cx}" cy="{cy}" r="88" fill="none" stroke="#ffffff" '
        'stroke-width="4" opacity="0.9"/>\n'
        f'  <circle cx="{cx}" cy="{cy}" r="88" fill="none" stroke="{ring}" '
        'stroke-width="8"/>\n'
        f'  <circle cx="{cx}" cy="{cy}" r="76" fill="none" stroke="{ring}" '
        'stroke-width="3" opacity="0.85"/>'
    )

# ----------------------------------------------------------------------------
# Définition des fichiers
# ----------------------------------------------------------------------------
files = {}

# ----- LCD RGB (L2) -----
files["step1-L2-repos.svg"] = (
    svg_open() + lcd_tint_white() + "\n  " + LCD_TEXT + "\n</svg>\n"
)

files["step1-L2-jaune.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_tint_yellow() + "\n  " + LCD_TEXT + "\n  "
    + led_halo(*LED_D2, "y") + "\n  "
    + button_halo(*BTN_SW1, "y")
    + "\n</svg>\n"
)

files["step1-L2-vert.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_tint_green() + "\n  " + LCD_TEXT + "\n  "
    + led_halo(*LED_D1, "g") + "\n  "
    + button_halo(*BTN_SW2, "g")
    + "\n</svg>\n"
)

files["step1-L2-bleu.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_tint_blue() + "\n  " + LCD_TEXT + "\n  "
    + button_halo(*BTN_SW3, "b")
    + "\n</svg>\n"
)

# ----- LCD monochrome (L1) — rétroéclairage jaune -----
files["step1-L1-repos.svg"] = (
    svg_open() + lcd_tint_mono() + "\n  " + LCD_TEXT + "\n</svg>\n"
)

files["step1-L1-jaune.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_tint_mono() + "\n  " + LCD_TEXT + "\n  "
    + led_halo(*LED_D2, "y") + "\n  "
    + button_halo(*BTN_SW1, "y")
    + "\n</svg>\n"
)

files["step1-L1-vert.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_tint_mono() + "\n  " + LCD_TEXT + "\n  "
    + led_halo(*LED_D1, "g") + "\n  "
    + button_halo(*BTN_SW2, "g")
    + "\n</svg>\n"
)

files["step1-L1-bleu.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_tint_mono() + "\n  " + LCD_TEXT + "\n  "
    + button_halo(*BTN_SW3, "b")
    + "\n</svg>\n"
)

# ----- Sans écran (L0) — la photo de fond montre déjà l'absence d'écran -----
files["step1-L0-jaune.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_none() + "\n  "
    + led_halo(*LED_D2, "y") + "\n  "
    + button_halo(*BTN_SW1, "y")
    + "\n</svg>\n"
)

files["step1-L0-vert.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_none() + "\n  "
    + led_halo(*LED_D1, "g") + "\n  "
    + button_halo(*BTN_SW2, "g")
    + "\n</svg>\n"
)

files["step1-L0-bleu.svg"] = (
    svg_open(GRAD_Y + GRAD_G + GRAD_B)
    + lcd_none() + "\n  "
    + button_halo(*BTN_SW3, "b")
    + "\n</svg>\n"
)

# ----- Étape 3 : mise en évidence du potentiomètre Pot1 -----
files["step3.svg"] = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 928 624" width="928" height="624">
  <defs>
    <radialGradient id="gP">
      <stop offset="0%" stop-color="#28a745" stop-opacity="0.85"/>
      <stop offset="45%" stop-color="#28a745" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#28a745" stop-opacity="0"/>
    </radialGradient>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#28a745"/>
    </marker>
  </defs>
  <rect width="928" height="624" fill="none"/>
  <circle cx="{POT_P1[0]}" cy="{POT_P1[1]}" r="105" fill="url(#gP)"/>
  <circle cx="{POT_P1[0]}" cy="{POT_P1[1]}" r="90" fill="none" stroke="#ffffff" stroke-width="4" opacity="0.9"/>
  <circle cx="{POT_P1[0]}" cy="{POT_P1[1]}" r="90" fill="none" stroke="#28a745" stroke-width="8"/>
  <circle cx="{POT_P1[0]}" cy="{POT_P1[1]}" r="76" fill="none" stroke="#28a745" stroke-width="3" opacity="0.85"/>
  <path d="M {POT_P1[0]-72} {POT_P1[1]-55} A 95 95 0 0 0 {POT_P1[0]-72} {POT_P1[1]+55}"
        fill="none" stroke="#28a745" stroke-width="6" marker-end="url(#arr)"/>
  <path d="M {POT_P1[0]+72} {POT_P1[1]-55} A 95 95 0 0 1 {POT_P1[0]+72} {POT_P1[1]+55}"
        fill="none" stroke="#28a745" stroke-width="6" marker-end="url(#arr)"/>
  <text x="{POT_P1[0]}" y="{POT_P1[1]-125}" font-family="sans-serif" font-size="24"
        font-weight="bold" fill="#1a6e2e" text-anchor="middle">Tournez !</text>
</svg>
'''

# ----------------------------------------------------------------------------
# Écriture des fichiers
# ----------------------------------------------------------------------------
for name, content in files.items():
    path = os.path.join(OUT_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  ecrit : {path}")

print(f"\n{len(files)} fichiers SVG generes dans '{OUT_DIR}/'.")
print("Pensez à placer board.png (avec LCD) et board-nolcd.png (sans LCD)")
print("dans le même dossier 'images/'.")
