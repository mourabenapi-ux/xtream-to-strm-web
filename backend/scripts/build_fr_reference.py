"""Construit la liste de référence des chaînes françaises (numéro + groupe + identité).

La référence est le pivot de l'organisation automatique : le moteur ne classe plus
rien de lui-même, il rapproche le catalogue des providers de cette liste et en reprend
le numéro, le groupe et le nom canonique.

Elle est bâtie en trois couches, de la plus fiable à la plus large :

1. **ARCOM** — la numérotation officielle TNT 1→26 en vigueur depuis le 6 juin 2025.
   Écrite en dur : c'est un fait réglementaire, pas une donnée à deviner.
2. **Curatée** — les chaînes premium (beIN, Canal+, Ciné+/OCS, RMC Sport, Eurosport,
   DAZN…) qu'aucune source publique n'ordonne, parce qu'aucune n'est une liste de
   chaînes payantes. Numérotées à la main, dans l'ordre où on veut les voir.
3. **Automatique** — le reste du guide XMLTV, classé par catégorie iptv-org puis par
   mots-clés, et numéroté alphabétiquement dans la tranche de son groupe.

**Les identifiants viennent du guide, pas d'ailleurs.** Le `tvg_id` de chaque entrée est
l'identifiant que la source XMLTV de l'utilisateur déclare réellement (xmltvfr.fr, 785
chaînes). Prendre ceux d'iptv-org aurait produit une référence cohérente avec elle-même
et muette dans TiviMate : les deux vocabulaires divergent (`arte.fr` contre `Arte.fr`,
`RMCStory.fr` contre `Numero23.fr`, et iptv-org ne connaît ni beIN ni DAZN en France).
iptv-org ne sert donc qu'à la catégorie et aux alias.

Usage (depuis le conteneur, où Redis porte le cache du guide) :

    python scripts/build_fr_reference.py --epg-source-id 1

ou hors ligne, à partir d'exports :

    python scripts/build_fr_reference.py --guide-dump guide.json --iptv-org channels.json

Le script ne réécrit le fichier que si tout est cohérent : un identifiant épinglé absent
du guide est signalé et bloque l'écriture, sauf --force. C'est volontaire — une référence
qui pointe vers un identifiant mort est pire que pas de référence, elle organise des
chaînes sans guide.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

OUTPUT = Path(__file__).resolve().parent.parent / "app" / "data" / "fr_channel_reference.json"
IPTV_ORG_URL = "https://iptv-org.github.io/api/channels.json"

# --- Les tranches de numérotation -------------------------------------------------
#
# Un groupe = une tranche. Le moteur numérote à l'intérieur de la tranche, donc une
# chaîne ajoutée plus tard ne décale jamais les autres groupes.

BLOCKS: List[Tuple[str, int, int]] = [
    ("TNT", 1, 27),
    ("Généralistes & Divertissement", 30, 99),
    ("Info", 100, 199),
    ("Cinéma & Séries", 200, 299),
    ("Sport", 300, 399),
    ("Découverte", 400, 499),
    ("Jeunesse", 500, 549),
    ("Musique", 550, 599),
    ("Régionales & Locales", 600, 749),
    ("Multiplex & Événements", 750, 949),
    ("Divers", 950, 999),
]

# 1000+ est laissé au moteur pour la queue hors référence, 9000+ pour le groupe Secours.

# --- Couche 1 : ARCOM -------------------------------------------------------------
#
# Numérotation officielle de la TNT, délibération du 9 janvier 2025, en vigueur depuis
# le 6 juin 2025. Le numéro est le numéro réel, pas un rang dans une liste.
# Le nom est celui de la chaîne, pas celui du guide : xmltvfr affiche "RMC Life" pour
# Chérie 25 (rebaptisée) et "TFX" sous l'identifiant NT1.fr — deux dérives d'après
# renommage qu'on absorbe ici plutôt que de les laisser polluer le rapprochement.

ARCOM: List[Tuple[int, str, str, List[str]]] = [
    (1, "TF1", "TF1.fr", ["tf1 hd", "tf1 4k", "tf1 uhd"]),
    (2, "France 2", "France2.fr", ["france2", "fr2"]),
    (3, "France 3", "France3.fr", ["france3", "fr3"]),
    (4, "France 4", "France4.fr", ["france4"]),
    (5, "France 5", "France5.fr", ["france5"]),
    (6, "M6", "M6.fr", ["m 6"]),
    (7, "Arte", "Arte.fr", ["arte hd", "arte fr"]),
    (8, "LCP-Public Sénat", "LaChaineParlementaire.fr",
     ["lcp", "la chaine parlementaire", "public senat", "lcp public senat"]),
    (9, "W9", "W9.fr", []),
    (10, "TMC", "TMC.fr", []),
    (11, "TFX", "NT1.fr", ["nt1", "tfx hd"]),
    (12, "Gulli", "Gulli.fr", []),
    (13, "BFM TV", "BFMTV.fr", ["bfm", "bfmtv"]),
    (14, "CNEWS", "CNews.fr", ["cnews", "c news"]),
    (15, "LCI", "LCI.fr", ["la chaine info"]),
    (16, "Franceinfo", "FranceInfo.fr",
     ["france info", "franceinfo", "france nfo", "france info tv"]),
    # Pas de « cstar hits » : CStar Hits France est une entrée à part.
    (17, "CStar", "CStar.fr", ["c star"]),
    (18, "T18", "T18.fr", ["t 18"]),
    (19, "NOVO19", "NOVO19.fr", ["novo 19", "novo19"]),
    (20, "TF1 Séries Films", "TF1SeriesFilms.fr",
     ["tf1 series film", "tf1 series films", "tf1 serie film"]),
    (21, "L'Équipe", "LEquipe21.fr",
     ["l equipe", "l equipe 21", "l equipe21", "la chaine l equipe", "equipe 21"]),
    (22, "6ter", "6ter.fr", ["6 ter"]),
    (23, "RMC Story", "Numero23.fr", ["numero 23", "rmc story"]),
    (24, "RMC Découverte", "RMCDecouverte.fr", ["rmc decouverte"]),
    (25, "RMC Life", "Cherie25.fr", ["cherie 25", "cherie25", "rmc life"]),
    (26, "Paris Première", "ParisPremiere.fr", ["paris premiere"]),
]

# --- Couche 2 : le bloc curaté ----------------------------------------------------
#
# (groupe, nom, tvg_id, alias). L'ordre de la liste est l'ordre à l'écran : les entrées
# curatées prennent le début de leur tranche, l'automatique s'ajoute derrière.
# Les alias comportent les fautes de frappe réelles des providers — "anal+sport 360"
# n'est pas une coquille de ma part, c'est le nom que le provider Aziza envoie.

CURATED: List[Tuple[str, str, str, List[str]]] = [
    # ---- Sport (300+) : l'ordre est celui d'un plan de service, pas l'alphabet.
    ("Sport", "beIN SPORTS 1", "beINSPORTS1.fr", ["bein sports 1", "bein sport 1", "bein 1"]),
    ("Sport", "beIN SPORTS 2", "beINSPORTS2.fr", ["bein sports 2", "bein sport 2", "bein 2"]),
    ("Sport", "beIN SPORTS 3", "beINSPORTS3.fr", ["bein sports 3", "bein sport 3", "bein 3"]),
    ("Sport", "beIN SPORTS MAX 4", "beINSPORTSMAX4.fr",
     ["bein max 4", "bein sport max 4", "bein sports max 4"]),
    ("Sport", "beIN SPORTS MAX 5", "beINSPORTSMAX5.fr",
     ["bein max 5", "bein sport max 5", "bein sports max 5"]),
    ("Sport", "beIN SPORTS MAX 6", "beINSPORTSMAX6.fr",
     ["bein max 6", "bein sport max 6", "bein sports max 6"]),
    ("Sport", "beIN SPORTS MAX 7", "beINSPORTSMAX7.fr",
     ["bein max 7", "bein sport max 7", "bein sports max 7"]),
    ("Sport", "beIN SPORTS MAX 8", "beINSPORTSMAX8.fr",
     ["bein max 8", "bein sport max 8", "bein sports max 8"]),
    ("Sport", "beIN SPORTS MAX 9", "beINSPORTSMAX9.fr",
     ["bein max 9", "bein sport max 9", "bein sports max 9"]),
    ("Sport", "beIN SPORTS MAX 10", "beINSPORTSMAX10.fr",
     ["bein max 10", "bein sport max 10", "bein sports max 10"]),
    ("Sport", "Canal+ Sport", "CanalPlusSport.fr", ["canal+sport", "canal plus sport"]),
    ("Sport", "Canal+ Sport 360", "CanalPlusSport360.fr",
     ["canal+ 360", "canal+sport 360", "anal+sport 360", "canal plus sport 360"]),
    ("Sport", "Canal+ Foot", "CanalPlusFoot.fr", ["canal+foot", "canal plus foot"]),
    ("Sport", "CANAL+ Ligue 1", "CanalPlusLigue1.fr",
     ["canal+ ligue1", "canal+ligue1", "canal+ ligue 1 uber eats"]),
    ("Sport", "Canal+ Premier League", "CanalPlusPremierLeague.fr", ["canal+premier league"]),
    ("Sport", "Ligue 1+", "Ligue1Plus.fr", ["ligue1+", "ligue 1 plus"]),
    ("Sport", "RMC Sport 1", "RMCSport1.fr", ["rmc sport 1"]),
    ("Sport", "RMC Sport 2", "RMCSport2.fr", ["rmc sport 2"]),
    # Pas d'alias « rmc sport live 3 » : RMC Sport Live 3 est une entrée à part (bloc
    # Multiplex), et l'alias la rendait inatteignable — la première entrée insérée gagne.
    ("Sport", "RMC Sport 3", "RMCSport3.fr", ["rmc sport 3"]),
    ("Sport", "RMC Sport 4", "RMCSport4.fr", ["rmc sport 4"]),
    ("Sport", "RMC Sport UHD", "RMCSportUHD.fr", ["rmc sport uhd", "rmc sport 4k"]),
    ("Sport", "Eurosport 1", "Eurosport1.fr", ["eurosport 1", "eurosport1", "euro sport 1"]),
    ("Sport", "Eurosport 2", "Eurosport2.fr", ["eurosport 2", "eurosport2", "euro sport 2"]),
    ("Sport", "DAZN 1", "DAZN.fr", ["dazn 1", "dazn1", "dazn"]),
    ("Sport", "DAZN 2", "DAZN2.fr", ["dazn 2"]),
    ("Sport", "DAZN 3", "DAZN3.fr", ["dazn 3"]),
    ("Sport", "DAZN 4", "DAZN4.fr", ["dazn 4"]),
    ("Sport", "DAZN 5", "DAZN5.fr", ["dazn 5"]),
    ("Sport", "InfosportPlus", "InfosportPlus.fr", ["infosport", "infosport+"]),
    ("Sport", "Golf+", "GolfPlus.fr", ["golf plus", "golf channel"]),
    ("Sport", "Equidia", "Equidia.fr", ["equidia live"]),
    ("Sport", "Automoto la chaîne", "ABMoteurs.fr", ["ab moteur", "ab moteurs", "automoto tv"]),
    ("Sport", "RMC Talk Sport", "RMCTalkSport.fr", ["rmc after foot tv", "rmc talk sport"]),
    ("Sport", "OLPLAY", "OLTV.fr", ["ol tv", "oltv", "olplay"]),
    # Sans guide : xmltvfr ne publie pas ces canaux thématiques Canal+, que les deux
    # providers servent pourtant. Numérotés ici, ils resteront sans programme.
    ("Sport", "Canal+ Formula 1", "", ["canal+formula1", "canal+ formula1", "canal+ f1"]),
    ("Sport", "Canal+ Top 14", "", ["canal+top14", "canal+ top14", "canal+ top 14"]),
    ("Sport", "Canal+ Moto GP", "", ["canal+moto gp", "canal+ moto gp", "canal+motogp"]),
    ("Sport", "Canal+ CAN", "", ["canal+ can", "canal+can"]),
    ("Sport", "Extreme Sports", "", ["extreme sports", "extreme sport"]),

    # ---- Cinéma & Séries (200+)
    # "canal" tout court : Aziza nomme Canal+ « FR_CANAL_HD », sans le plus. L'alias est
    # sûr parce que les vraies « Canal 9 », « Canal 21 », « Canal 32 » finissent par un
    # nombre, et que le rapprochement flou refuse de franchir un nombre final.
    ("Cinéma & Séries", "Canal+", "CanalPlus.fr",
     ["canal plus", "canal+ hd", "canal+ 4k", "canal"]),
    ("Cinéma & Séries", "Canal+ Cinéma", "CanalPlusCinema.fr",
     ["canal+cinema", "canal+ cinema", "canal plus cinema"]),
    ("Cinéma & Séries", "Canal+ Séries", "CanalPlusSeries.fr", ["canal+series", "canal+ series"]),
    ("Cinéma & Séries", "CANAL+ BOX OFFICE", "CanalPlusBoxOffice.fr", ["canal+ box office"]),
    ("Cinéma & Séries", "Canal+ Grand Écran", "CanalPlusGrandEcran.fr", ["canal+ grand ecran"]),
    # Les sœurs du bouquet OCS ne sont PAS des alias d'OCS. Les avoir écrites ici a fait
    # converger 35 flux fournisseur sur cette entrée : une seule était servie, les cinq
    # autres finissaient en Secours sous le libellé « OCS (HD) », ce qui est un mensonge
    # sur ce qu'elles sont. Le fournisseur, lui, leur donne cinq identifiants distincts —
    # OCSMax.fr, OrangeCinechoc.fr, OCSGeants.fr, OrangeCineHappy.fr,
    # CinecinemaPremier.fr — donc ce sont bien cinq chaînes.
    ("Cinéma & Séries", "OCS", "CinePlusPremier.fr", ["ocs hd", "ocs fr"]),
    # Sans identifiant : le guide de l'utilisateur ne publie qu'« OCS », comme il ne
    # publie plus C8 ni NRJ 12. Elles méritent leur numéro quand même, et le moteur leur
    # laisse l'identifiant que le fournisseur fournit.
    ("Cinéma & Séries", "Ciné+ Premier", "", ["cine premier", "cine cinema premier",
                                              "cine+ premiere", "cine premiere"]),
    ("Cinéma & Séries", "OCS Max", "", ["ocs max"]),
    ("Cinéma & Séries", "OCS Choc", "", ["ocs choc", "orange cine choc"]),
    ("Cinéma & Séries", "OCS City", "", ["ocs city", "orange cine novo"]),
    ("Cinéma & Séries", "OCS Géants", "", ["ocs geants", "ocs geant", "orange cine geants"]),
    ("Cinéma & Séries", "OCS Pulp", "", ["ocs pulp", "orange cine happy"]),
    ("Cinéma & Séries", "Ciné+ Frisson", "CinePlusFrisson.fr", ["cine+ frisson", "cine frisson"]),
    ("Cinéma & Séries", "Ciné+ Émotion", "CinePlusEmotion.fr", ["cine+ emotion", "cine emotion"]),
    ("Cinéma & Séries", "Ciné+ Classic", "CinePlusClassic.fr", ["cine+ classic", "cine classic"]),
    ("Cinéma & Séries", "Ciné+ Festival", "CinePlusClub.fr", ["cine+ club", "cine club"]),
    ("Cinéma & Séries", "Ciné+ Family", "CinePlusFamiz.fr", ["cine+ famiz", "cine famiz"]),
    ("Cinéma & Séries", "Action", "Action.fr", []),
    ("Cinéma & Séries", "TCM Cinéma", "TCM.fr", ["tcm cinema"]),
    ("Cinéma & Séries", "Paramount Channel", "ParamountChannel.fr", ["paramount channel"]),
    ("Cinéma & Séries", "Warner TV", "WarnerTV.fr", ["warner tv", "warner bros"]),
    ("Cinéma & Séries", "Syfy", "Syfy.fr", []),
    ("Cinéma & Séries", "13ème Rue", "13eRue.fr", ["13eme rue", "13 eme rue"]),
    ("Cinéma & Séries", "Polar+", "PolarPlus.fr", ["polar +", "polar plus"]),
    ("Cinéma & Séries", "Comédie+", "ComediePlus.fr", ["comedie", "comedie +", "comedy central"]),
    ("Cinéma & Séries", "Série Club", "serieclub.fr", ["serie club"]),
    ("Cinéma & Séries", "AB3", "AB3.fr", []),
    ("Cinéma & Séries", "AB1", "AB1.fr", []),

    # ---- Découverte (400+)
    ("Découverte", "National Geographic", "NationalGeographic.fr", ["nat geo", "national geo"]),
    ("Découverte", "Ushuaïa TV", "UshuaiaTV.fr", ["ushuaia", "ushuaia tv"]),
    ("Découverte", "Planète+", "PlanetePlus.fr", ["planete+", "planete plus", "planet plus"]),
    ("Découverte", "Planète+ Aventure", "PlaneteAction.fr", ["planete a e", "planete+ a e"]),
    ("Découverte", "Planète+ Crime", "PLANETEJustice.fr", ["planete ci", "planete+ ci"]),
    ("Découverte", "Histoire TV", "Histoire.fr", ["histoire"]),
    ("Découverte", "Toute l'Histoire", "TouteHistoire.fr", ["toute l histoire"]),
    ("Découverte", "Science & Vie TV", "ScienceEtVieTV.fr", ["science et vie", "sciences vie"]),
    ("Découverte", "Discovery Channel", "DiscoveryChannel.fr", ["discovery", "discovery tv"]),
    ("Découverte", "Discovery Investigation", "DiscoveryInvestigation.fr",
     ["discovery investigation"]),
    ("Découverte", "TLC", "DiscoveryScience.fr", ["discovery science", "tlc"]),
    ("Découverte", "Seasons", "Seasons.fr", ["season"]),
    ("Découverte", "Chasse et Pêche", "ChasseEtPeche.fr", ["chasse peche", "chasse et peche"]),
    ("Découverte", "Animaux", "Animaux.fr", []),
    ("Découverte", "MUSEUM TV", "Museum.fr", ["museum"]),
    ("Découverte", "Canal+ Docs", "CanalPlusDocs.fr", ["canal+ docs"]),

    # ---- Jeunesse (500+)
    ("Jeunesse", "Gulli", "Gulli.fr", []),  # doublon TNT volontaire : filtré à la sortie
    ("Jeunesse", "Disney Channel", "DisneyChannel.fr", ["disney channel"]),
    ("Jeunesse", "Disney Junior", "DisneyJunior.fr", ["disney junior", "disneyjunior"]),
    ("Jeunesse", "Disney XD", "DisneyXD.fr", ["disney xd"]),
    ("Jeunesse", "Nickelodeon", "Nickelodeon.fr", ["nickelodeon", "nickeledon"]),
    ("Jeunesse", "Nickelodeon Junior", "NickelodeonJunior.fr", ["nick jr", "nickelodeon junior"]),
    ("Jeunesse", "Nickelodeon Teen", "Nickelodeon4Teen.fr", ["nickelodeon 4 teen"]),
    ("Jeunesse", "Cartoon Network", "CartoonNetwork.fr", ["cartoon network"]),
    ("Jeunesse", "Cartoonito", "Boing.fr", ["boing", "cartoonito"]),
    ("Jeunesse", "Boomerang", "Boomerang.fr", []),
    ("Jeunesse", "Piwi+", "PIWI.fr", ["piwi", "piwi +"]),
    ("Jeunesse", "TIJI", "TIJI.fr", ["tiji"]),
    ("Jeunesse", "CANAL J", "CanalJ.fr", ["canal+j", "canal j"]),
    ("Jeunesse", "Mangas", "Mangas.fr", []),
    ("Jeunesse", "Warner TV Next", "Toonami.fr", ["toonami", "warner tv next"]),
    ("Jeunesse", "GameOne", "GameOne.fr", ["game one"]),
    ("Jeunesse", "J-One", "JOne.fr", ["j one", "jone"]),
    ("Jeunesse", "Canal+ Kids", "CanalPlusKIDS.fr", ["canal+kids", "canal+ family"]),

    # ---- Musique (550+)
    ("Musique", "M6 Music", "M6Music.fr", ["m6 music"]),
    ("Musique", "MCM", "MCM.fr", []),
    ("Musique", "MCM Top", "MCMTop.fr", ["mcm top"]),
    ("Musique", "MTV", "MTV.fr", []),
    ("Musique", "NRJ Hits", "NRJHits.fr", ["nrj hits"]),
    ("Musique", "RFM TV", "RFMTV.fr", ["rfm tv"]),
    ("Musique", "Trace Urban", "TraceUrban.fr", ["trace urban"]),
    ("Musique", "StingrayDjazz", "StingrayDjazz.fr", ["djazz", "djazz 1"]),
    ("Musique", "Melody TV", "Melody.fr", ["melody", "melody tv"]),
    ("Musique", "MTV Live", "", ["mtv live"]),

    # ---- Info (100+) : les chaînes d'info hors TNT
    ("Info", "France 24", "France24.fr", ["france 24"]),
    ("Info", "BFM Business", "BFMBusiness.fr", ["bfm business"]),
    ("Info", "CNews Prime", "CNewsPrime.fr", ["cnews prime"]),
    ("Info", "RMC Talk Info", "RMCTalkInfo.fr", ["rmc talk info"]),
    ("Info", "TECH & CO", "01TV.fr", ["tech eco", "tech co", "01 tv"]),

    # ---- Généralistes & Divertissement (30+)
    ("Généralistes & Divertissement", "TV Breizh", "TvBreizh.fr", ["tv breizh"]),
    ("Généralistes & Divertissement", "Teva", "Teva.fr", []),
    ("Généralistes & Divertissement", "RTL9", "RTL9.fr", ["rtl 9"]),
    ("Généralistes & Divertissement", "RMC WOW", "RMCWOW.fr", ["rmc wow"]),
    ("Généralistes & Divertissement", "RMC Mystère", "RMCMystere.fr", ["rmc mystere"]),
    ("Généralistes & Divertissement", "RMC Mecanic", "RMCMecanic.fr", ["rmc mecanic"]),
    ("Généralistes & Divertissement", "RMC Alerte Secours", "RMCAlerteSecours.fr",
     ["rmc alerte secours"]),
    # C8 et NRJ12 ont perdu leur fréquence TNT en 2025 : l'ARCOM ne leur donne plus de
    # numéro et xmltvfr a cessé de les publier. Les deux abonnements les servent
    # toujours, donc elles gardent une place ici — en tête des généralistes, sans guide.
    ("Généralistes & Divertissement", "C8", "", ["c8", "c 8"]),
    ("Généralistes & Divertissement", "NRJ 12", "", ["nrj12", "nrj 12"]),

    # Rien n'est épinglé dans "Multiplex & Événements" : ces canaux (Eurosport 360 1→32,
    # Canal+ Live 1→19, Ligue 1+ 2→10, L'Equipe Live 1→7) n'ont pas d'ordre à défendre,
    # seulement leur propre numéro. Le tri naturel les range tout seul, et les épingler
    # aurait juste dédoublé le canal n° 1 de chaque famille.
]

# --- Couche 2 bis : les familles numérotées ---------------------------------------
#
# Les providers servent des blocs de canaux d'événement — RMC Sport 5→15, Canal+ Play
# 1→8, A la carte 1→10 — dont le guide ne publie aucun. Sans eux la queue de liste se
# remplit de 70 chaînes qui, elles, ont un ordre évident : le leur.
#
# Ils n'ont volontairement pas de tvg_id : leur programme change à chaque événement, et
# leur inventer un identifiant les aurait collés sur la grille d'une autre chaîne.
#
# (groupe, gabarit du nom, premier, dernier, gabarits d'alias)

NUMBERED_FAMILIES: List[Tuple[str, str, int, int, List[str]]] = [
    ("Multiplex & Événements", "RMC Sport {n}", 5, 15, ["rmc sport {n}"]),
    ("Multiplex & Événements", "RMC Sport Live {n}", 1, 17,
     ["rmc sport live {n}", "rmc access sport {n}"]),
    ("Multiplex & Événements", "Canal+ Play {n}", 1, 8, ["canal+play{n}", "canal+ play {n}"]),
    ("Multiplex & Événements", "My Canal+ {n}", 1, 5, ["my canal+{n}", "my canal+ {n}"]),
    ("Multiplex & Événements", "À la carte {n}", 1, 10, ["a la carte {n}"]),
    # Bloc cinéma, pas multiplex : ce sont huit canaux de films. Le profil compact fond
    # « Multiplex & Événements » dans Sport, et ce mauvais rangement les y envoyait.
    ("Cinéma & Séries", "OCS Go Ciné {n}", 1, 8, ["ocs go cine {n}"]),
    ("Multiplex & Événements", "Sports {n}", 1, 6, ["sports {n}", "sport {n}"]),
    ("Multiplex & Événements", "Eurosport {n}", 4, 9, ["eurosport {n}", "euro sport {n}"]),
]


# --- Classement automatique du reste ----------------------------------------------
#
# D'abord la catégorie iptv-org quand elle existe, sinon des mots-clés. Tout ce qui
# ne tombe dans aucune règle va dans "Divers" — jamais deviné, jamais silencieux.

IPTV_ORG_CATEGORY_TO_GROUP = {
    "sports": "Sport",
    "news": "Info",
    "business": "Info",
    "weather": "Info",
    "legislative": "Info",
    "movies": "Cinéma & Séries",
    "series": "Cinéma & Séries",
    "classic": "Cinéma & Séries",
    "comedy": "Cinéma & Séries",
    "kids": "Jeunesse",
    "animation": "Jeunesse",
    "family": "Jeunesse",
    "music": "Musique",
    "documentary": "Découverte",
    "science": "Découverte",
    "education": "Découverte",
    "auto": "Découverte",
    "outdoor": "Découverte",
    "cooking": "Découverte",
    "travel": "Découverte",
    "general": "Généralistes & Divertissement",
    "entertainment": "Généralistes & Divertissement",
    "lifestyle": "Généralistes & Divertissement",
    "culture": "Généralistes & Divertissement",
    "relax": "Généralistes & Divertissement",
}

# Catégories qu'on n'embarque pas du tout dans la référence.
EXCLUDED_CATEGORIES = {"xxx", "shop", "interactive"}

# iptv-org ne marque "xxx" que ce qu'il connaît, et le guide contient une dizaine de
# chaînes adultes qu'il ignore. Elles seraient numérotées au milieu de la jeunesse.
EXCLUDED_KEYWORDS = re.compile(
    r"dorcel|hustler|penthouse|playboy|pink tv|man x|manx|xxl|brazzers|vivid|redlight"
)

KEYWORD_RULES: List[Tuple[str, str]] = [
    ("Régionales & Locales",
     r"^france 3 [a-z]|^bfm (alsace|lyon|marseille|grand|nice|paris|dici|normandie|lille"
     r"|toulouse|toulon|var|cote|littoral|alpes|provence)"
     # "tele" attrape les télés de ville, pas Télétoon ni les téléfilms ; "tv5" est une
     # chaîne internationale, pas une locale, malgré le chiffre qui suit "tv".
     r"|^tele(?!toon|film)|^tebeo|^tebesud|^via |^via[a-z]|^tv ?(?!5)\d"
     r"|^tv (tours|rennes|breizh izel|sud)"
     r"|1ere$|\b(vosges|bordeaux|nantes|grenoble|limoges|sarthe|angers|mirabelle|matele)\b"
     r"|guadeloupe|martinique|guyane|reunion|mayotte|tahiti|polynesie|wallis|miquelon"
     r"|caledonie|canal ?(9|21)$|union tv|il tv|bip tv|weo"),
    ("Multiplex & Événements",
     r"(live|multiplex|event|evenement|360|a la carte|play|ligue 1\+) ?\d+$"
     r"|\bppv\b|only events|evenement|a la carte"),
    ("Sport", r"sport|foot|rugby|golf|tennis|basket|hand|moto|formula|\bf1\b|equide|equidia"
              r"|dazn|bein|olplay|\bginx\b|esport|fight"),
    ("Jeunesse", r"kids|junior|jeunesse|enfant|disney|nickel|cartoon|boomerang|gulli|piwi|tiji"
                 r"|manga|anime|toon|baby ?tv|pitchoun|gong|dreamworks"),
    ("Musique", r"music|musique|mtv|mcm|nrj|rfm|trace|mezzo|melody|jazz|clubbing|hits|vh1"
                r"|stingray|classica|concert|zouk|djaz"),
    ("Cinéma & Séries", r"cine|cinema|film|serie|movie|comedie|comedy|action|thriller|polar"
                        r"|western|novelas|nollywood|sundance"),
    ("Découverte", r"docu|discovery|nat ?geo|histoire|science|planete|ushuaia|animaux|chasse"
                   r"|peche|museum|seasons|trek|cheval|nautical|lucky jack|marmiton|cuisine"
                   r"|maison|travaux|auto ?plus|turbo|luxe|esprit sorcier"),
    ("Info", r"\binfo\b|news|bfm|cnews|lci|euronews|i24|actu|figaro|meteo|senat|parlement"),
    ("Généralistes & Divertissement", r"^tv5|24 ?24|24/24|elle girl|\bkto\b|canvas|\bcgtn\b"),
]

# Déclinaisons d'une chaîne déjà épinglée : le guide les publie comme des chaînes à part
# entière, mais ce sont la même antenne en 4K ou décalée d'une heure. Les numéroter à
# part briserait le principe même de l'organisation, qui est de fusionner les variantes.
# Elles rejoignent donc les alias de leur chaîne de base.
VARIANT_SUFFIX = re.compile(r"(4k|uhd|plus ?1|\+ ?1|decale|offset)$", re.IGNORECASE)

# Alias qu'iptv-org publie et qui désignent une autre chaîne, sans qu'une entrée de la
# référence permette de le prouver. Jugement, donc explicite : « Euronews Russki » est un
# canal en russe, pas un autre nom d'Euronews.
ALIAS_BLOCKLIST = {"euronews russki"}


def strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def natural_key(value: str) -> List[Any]:
    """Tri où « Live 2 » précède « Live 10 » — l'alphabet ne sait pas compter."""
    return [int(part) if part.isdigit() else part
            for part in re.split(r"(\d+)", norm(value))]


def norm(value: str) -> str:
    """Clé de rapprochement : sans accent, sans ponctuation, en minuscules."""
    text = strip_accents(value or "").lower().replace("canal+", "canalplus")
    text = re.sub(r"[^a-z0-9+]+", " ", text)
    return " ".join(text.split())


def load_guide_from_redis(source_id: int) -> List[Dict[str, str]]:
    import redis  # importé ici : le script tourne aussi hors conteneur, sans redis

    client = redis.Redis(host="localhost", port=6379, decode_responses=True)
    ids = client.smembers(f"epg:src:{source_id}:channels")
    if not ids:
        raise SystemExit(
            f"La source EPG {source_id} n'a aucune chaîne en cache. "
            f"Rafraîchis-la depuis Global EPG Sources, puis relance."
        )
    channels = []
    for channel_id in sorted(ids):
        entry = client.hgetall(f"epg:src:{source_id}:channel:{channel_id}")
        channels.append({
            "id": channel_id,
            "name": entry.get("name") or channel_id,
            "icon": entry.get("icon") or "",
        })
    return channels


def load_json(path_or_url: str) -> Any:
    if path_or_url.startswith(("http://", "https://")):
        import urllib.request

        with urllib.request.urlopen(path_or_url) as response:
            return json.load(response)
    return json.loads(Path(path_or_url).read_text(encoding="utf-8"))


# Ces deux groupes-là se lisent dans la forme du nom, pas dans le genre : une France 3
# régionale et un canal Live 12 sont catalogués "general" et "sports" par iptv-org, ce
# qui est juste et inutilisable ici. Leurs règles passent donc avant la catégorie.
STRUCTURAL_GROUPS = ("Régionales & Locales", "Multiplex & Événements")


def classify(name: str, iptv_org: Optional[Dict[str, Any]]) -> Optional[str]:
    """Groupe d'une chaîne non épinglée, ou None si elle doit être écartée."""
    haystack = norm(name)
    if EXCLUDED_KEYWORDS.search(haystack):
        return None
    for group, pattern in KEYWORD_RULES:
        if group in STRUCTURAL_GROUPS and re.search(pattern, haystack):
            return group

    categories = (iptv_org or {}).get("categories") or []
    if categories and set(categories) <= EXCLUDED_CATEGORIES:
        return None
    for category in categories:
        group = IPTV_ORG_CATEGORY_TO_GROUP.get(category)
        if group:
            return group

    for group, pattern in KEYWORD_RULES:
        if re.search(pattern, haystack):
            return group
    return "Divers"


def build(guide: List[Dict[str, str]], iptv_org_channels: List[Dict[str, Any]],
          keep_suffixes: Tuple[str, ...]
          ) -> Tuple[Dict[str, Any], List[str], List[str]]:
    """Le document, les avertissements bloquants, puis les corrections appliquées.

    La distinction compte : un avertissement demande une décision humaine et retient
    l'écriture, une correction est déjà faite et n'a besoin que d'être lue. Les
    confondre rendait le script inutilisable dès que le garde-fou servait à quelque chose.
    """
    warnings: List[str] = []
    notices: List[str] = []

    # Le guide n'est pas propre : des noms arrivent en entités HTML ("S&eacute;ries")
    # et, quand la source ne déclare pas de display-name, xmltvfr recopie l'identifiant
    # dans le nom ("ATVGuadeloupe.fr"). On répare avant de s'en servir comme libellé.
    guide = [
        {**c, "name": (lambda n: n.rsplit(".", 1)[0] if n == c["id"] else n)(
            html.unescape(c.get("name") or c["id"]).strip())}
        for c in guide
    ]

    guide_by_id = {c["id"]: c for c in guide}
    org_by_id = {c["id"]: c for c in iptv_org_channels}
    # iptv-org et xmltvfr n'emploient pas le même vocabulaire d'identifiants : on les
    # relie par le nom normalisé, seul pont fiable entre les deux.
    org_by_name: Dict[str, Dict[str, Any]] = {}
    for channel in iptv_org_channels:
        if channel.get("country") not in ("FR", "MC"):
            continue
        for label in [channel["name"], *(channel.get("alt_names") or [])]:
            org_by_name.setdefault(norm(label), channel)

    entries: List[Dict[str, Any]] = []
    pinned_ids: set = set()

    def add(group: str, name: str, tvg_id: str, aliases: List[str], source: str,
            number: Optional[int] = None) -> None:
        # tvg_id vide = chaîne réelle que le guide ne couvre pas (C8, NRJ12 depuis leur
        # sortie de la TNT). Elle mérite son numéro et son groupe ; elle n'aura juste
        # pas de programme. La taire l'aurait renvoyée en queue de liste sans raison.
        key = tvg_id or f"@{norm(name)}"
        if key in pinned_ids:
            return  # une chaîne n'apparaît qu'une fois (Gulli est TNT, pas Jeunesse)
        guide_entry = guide_by_id.get(tvg_id) if tvg_id else None
        if tvg_id and guide_entry is None:
            warnings.append(f"{source}: identifiant absent du guide — {tvg_id} ({name})")
            return
        pinned_ids.add(key)
        org = org_by_id.get(tvg_id) or org_by_name.get(norm(name))
        all_aliases = {norm(a) for a in aliases}
        if guide_entry:
            all_aliases.add(norm(guide_entry["name"]))
        for label in (org or {}).get("alt_names") or []:
            all_aliases.add(norm(label))
        all_aliases.discard(norm(name))
        all_aliases.discard("")
        entries.append({
            "number": number,
            "group": group,
            "name": name,
            "tvg_id": tvg_id,
            "aliases": sorted(all_aliases),
            "logo": (guide_entry or {}).get("icon") or "",
            "source": source,
            "has_guide": bool(guide_entry),
        })

    for number, name, tvg_id, aliases in ARCOM:
        add("TNT", name, tvg_id, aliases, "arcom", number=number)

    for group, name, tvg_id, aliases in CURATED:
        add(group, name, tvg_id, aliases, "curated")

    for group, template, first, last, alias_templates in NUMBERED_FAMILIES:
        for index in range(first, last + 1):
            add(group, template.format(n=index), "",
                [a.format(n=index) for a in alias_templates], "family")

    entry_by_id = {e["tvg_id"]: e for e in entries}

    def fold_variant(channel: Dict[str, str]) -> bool:
        """Rattache une déclinaison 4K / +1 à sa chaîne de base. True si absorbée."""
        stem = channel["id"].rsplit(".", 1)[0]
        match = VARIANT_SUFFIX.search(stem)
        if not match:
            return False
        base_stem = stem[: match.start()].rstrip("-_ ").lower()
        if not base_stem:
            return False
        for tvg_id, entry in entry_by_id.items():
            if tvg_id.rsplit(".", 1)[0].lower() != base_stem:
                continue
            for label in (channel["name"], stem):
                alias = norm(label)
                if alias and alias != norm(entry["name"]) and alias not in entry["aliases"]:
                    entry["aliases"].append(alias)
            entry["aliases"].sort()
            return True
        return False

    for channel in sorted(guide, key=lambda c: natural_key(c["name"])):
        if channel["id"] in pinned_ids:
            continue
        if not channel["id"].endswith(keep_suffixes):
            continue
        if fold_variant(channel):
            continue
        org = org_by_id.get(channel["id"]) or org_by_name.get(norm(channel["name"]))
        group = classify(channel["name"], org)
        if group is None:
            continue
        add(group, channel["name"], channel["id"], [], "guide")
        entry_by_id = {e["tvg_id"]: e for e in entries}

    # Un alias ne doit jamais résoudre vers une chaîne que la référence liste déjà
    # séparément. Sinon la première entrée insérée la capture et l'autre devient
    # inatteignable — « cstar hits » masquait CStar Hits France, « rmc sport live 3 »
    # masquait RMC Sport Live 3, et personne ne le voyait parce que le résultat était
    # une chaîne servie sous un autre nom, pas une erreur. C'est démontrable, donc c'est
    # une passe automatique et pas une liste à tenir à la main.
    own_names = {norm(e["name"]): e["name"] for e in entries}
    for entry in entries:
        kept = []
        for alias in entry["aliases"]:
            if alias in ALIAS_BLOCKLIST:
                notices.append(f"alias sur liste noire retiré: « {alias} » "
                               f"({entry['name']})")
                continue
            other = own_names.get(alias)
            if other and other != entry["name"]:
                notices.append(f"alias masquant retiré: « {alias} » sur "
                               f"{entry['name']} désigne {other}")
                continue
            kept.append(alias)
        entry["aliases"] = kept

    # Numérotation : les entrées épinglées gardent leur numéro ARCOM, les autres
    # prennent la place suivante libre dans la tranche de leur groupe.
    block_bounds = {group: (start, end) for group, start, end in BLOCKS}
    by_group: Dict[str, List[Dict[str, Any]]] = {group: [] for group, _, _ in BLOCKS}
    for entry in entries:
        by_group[entry["group"]].append(entry)

    for group, start, end in BLOCKS:
        cursor = start
        taken = {e["number"] for e in by_group[group] if e["number"]}
        for entry in by_group[group]:
            if entry["number"]:
                continue
            while cursor in taken or cursor > end:
                if cursor > end:
                    warnings.append(
                        f"tranche saturée: {group} déborde de [{start}-{end}] "
                        f"à partir de « {entry['name']} »"
                    )
                    break
                cursor += 1
            if cursor > end:
                entry["number"] = None
                continue
            entry["number"] = cursor
            taken.add(cursor)

    entries = [e for e in entries if e["number"]]
    entries.sort(key=lambda e: e["number"])

    document = {
        "version": date.today().isoformat(),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "numbering_1_to_26": "ARCOM, délibération du 9 janvier 2025 (en vigueur 6 juin 2025)",
            "identifiers_and_logos": "guide XMLTV de l'utilisateur (xmltvfr.fr)",
            "categories_and_aliases": IPTV_ORG_URL,
            "premium_block": "curaté à la main — aucune source publique n'ordonne les chaînes payantes",
        },
        "blocks": [
            {"group": group, "start": start, "end": end,
             "count": sum(1 for e in entries if e["group"] == group)}
            for group, start, end in BLOCKS
        ],
        "tail_starts_at": 1000,
        "backup_starts_at": 9000,
        "channels": entries,
    }
    return document, warnings, notices


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--epg-source-id", type=int, default=1,
                        help="source EPG dont le cache Redis sert d'autorité (défaut: 1)")
    parser.add_argument("--guide-dump", help="JSON [{id,name,icon}] au lieu de Redis")
    parser.add_argument("--iptv-org", default=IPTV_ORG_URL,
                        help="channels.json d'iptv-org (URL ou fichier)")
    parser.add_argument("--keep-suffixes", default=".fr,.frdrom",
                        help="suffixes d'identifiants à embarquer (défaut: .fr,.frdrom)")
    parser.add_argument("--output", default=str(OUTPUT))
    parser.add_argument("--force", action="store_true",
                        help="écrire malgré les avertissements")
    args = parser.parse_args()

    guide = (load_json(args.guide_dump) if args.guide_dump
             else load_guide_from_redis(args.epg_source_id))
    iptv_org_channels = load_json(args.iptv_org)
    suffixes = tuple(s.strip() for s in args.keep_suffixes.split(",") if s.strip())

    document, warnings, notices = build(guide, iptv_org_channels, suffixes)

    print(f"guide      : {len(guide)} chaînes")
    print(f"iptv-org   : {len(iptv_org_channels)} chaînes")
    print(f"référence  : {len(document['channels'])} chaînes")
    for block in document["blocks"]:
        print(f"   {block['group']:32s} {block['start']:>4}-{block['end']:<4} "
              f"{block['count']:>4}")

    if notices:
        print(f"\n{len(notices)} correction(s) appliquée(s) :")
        for notice in notices:
            print(f"   - {notice}")

    if warnings:
        print(f"\n{len(warnings)} avertissement(s) :", file=sys.stderr)
        for warning in warnings:
            print(f"   - {warning}", file=sys.stderr)
        if not args.force:
            print("\nRien n'a été écrit. Corrige, ou relance avec --force.", file=sys.stderr)
            return 1

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"\nécrit : {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
