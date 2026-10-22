# Zajedno: grupno gledanje filmova

Samostalna aplikacija: prijava Google nalogom, sobe sa kodom, sinhronizovano gledanje, chat na dnu ekrana i glas preko mikrofona (WebRTC). Ne zavisi od claude.ai-ja.

## 1. Google prijava (jednom, oko 5 minuta)

1. Otvori https://console.cloud.google.com i napravi projekat (ili izaberi postojeći).
2. **APIs & Services → OAuth consent screen**: izaberi *External*, upiši naziv aplikacije i svoj email. Dok je aplikacija u režimu *Testing*, dodaj emailove ljudi koji će je koristiti u **Test users**. Za javno korištenje klikni *Publish app* (za osnovnu prijavu s imenom i emailom nije potrebna posebna verifikacija).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, tip **Web application**.
4. U **Authorized JavaScript origins** dodaj adresu na kojoj će aplikacija raditi:
   - lokalno: `http://localhost:3000`
   - na hostingu: `https://tvoja-aplikacija.onrender.com` (tačna adresa nakon postavljanja)
5. Kopiraj **Client ID** (završava na `.apps.googleusercontent.com`). Client secret ti ne treba.

## 2. Pokretanje na računaru

```bash
npm install
export GOOGLE_CLIENT_ID="...tvoj client id..."
export SESSION_SECRET="$(openssl rand -hex 32)"
npm start
```

Otvori http://localhost:3000. Za probu bez Googlea: `DEV_LOGIN=1 npm start` (pokazuje polje za ime; **nikad ne uključuj na internetu**; ime koje počinje s "Admin" dobija admin prava). Automatski test: pokreni server s `DEV_LOGIN=1 SESSION_SECRET=test PORT=3111`, pa u drugom terminalu `npm test`.

## 3. Postavljanje na internet

Mikrofon u pregledniku radi samo preko `https`, pa ti treba hosting s HTTPS-om. Najjednostavnije (Render, Railway, Fly.io ili bilo koji Node hosting):

- Otpremi folder na GitHub, napravi novi *Web Service*, build komanda `npm install`, start komanda `npm start`.
- U postavkama (Environment) dodaj: `GOOGLE_CLIENT_ID` i `SESSION_SECRET` (dugačak nasumičan niz).
- Adresu koju dobiješ dodaj u Google *Authorized JavaScript origins* (korak 1.4).
- Dok je besplatni plan "uspavan", prvi dolazak čeka nekoliko sekundi, a sobe se gube pri restartu.

## Katalog filmova i admin panel

Početna stranica je katalog u stilu Netflixa: istaknuti film, redovi po žanrovima i pretraga. Klik na film otvara detalje s dugmadima **Pogledaj trailer** i **Pogledaj u grupi**. Drugo stvara sobu u kojoj se svima prikazuje YouTube trailer (ako je za film upisan i link na cijeli film, pušta se on). Chat je stalno u donjem uglu: može se povećati, smanjiti, a ima karticu *Soba* i *Opšti chat*.

**Administrator** vidi *Admin panel* (dodavanje, uređivanje i brisanje filmova, opisi, žanrovi, postere, trailer linkovi, lista objavljenih filmova). Ko je admin određuje varijabla:

- `ADMIN_EMAILS`: Gmail adrese administratora, odvojene zarezom (npr. `kenanbjelic12@gmail.com`). Dodaj je na Renderu pod *Environment*.

### Trajna pohrana kataloga (preporučeno na Renderu)

Besplatni Render briše datoteke pri svakom restartu i deployu, pa bi se dodani filmovi izgubili. Zato koristi besplatnu Upstash Redis bazu:

1. Na https://upstash.com napravi račun i novu *Redis* bazu (besplatni plan je dovoljan).
2. Na stranici baze, u dijelu *REST API*, kopiraj **UPSTASH_REDIS_REST_URL** i **UPSTASH_REDIS_REST_TOKEN**.
3. Dodaj obje varijable na Renderu i pokreni novi deploy. Admin panel prestaje prikazivati upozorenje o pohrani.

Bez njih katalog se sprema u datoteku (`DATA_DIR`, zadano `./data`). To je u redu za probu i za hosting s trajnim diskom.

### Link na film

Polje *Link na film* (i polje "Pusti svima" u sobi) prima: YouTube link, Vimeo link, direktan video (`.mp4`, `.webm`), HLS (`.m3u8`) ili zalijepljen **iframe kod** (`<iframe src="…">`; aplikacija sama izvuče adresu). Play, pauza i premotavanje se sinhroniziraju za sve u sobi. Ostali embed servisi bez API-ja za kontrolu ne mogu se sinhronizirati i nisu podržani.

## Dodatne postavke (opcionalno)

| Varijabla | Šta radi |
|---|---|
| `ADMIN_EMAILS` | Admini kataloga (vidi gore). |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Trajna pohrana kataloga (vidi gore). |
| `DATA_DIR` | Mapa za datoteku kataloga ako se ne koristi Upstash. |
| `ALLOWED_EMAILS` | Spisak emailova odvojenih zarezom. Samo oni mogu ući (npr. za par ili uski krug). |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | TURN server za glas kad direktna veza ne uspije (stroge mreže, neki mobilni operateri). |
| `YOUTUBE_API_KEY` | Uključuje YouTube pretragu u aplikaciji (vidi ispod). Bez njega radi pretraga Internet Archivea i lijepljenje linkova. |
| `PORT` | Port servera (hosting ga obično postavi sam). |

## YouTube pretraga (opcionalno)

1. U Google Cloud Consoleu, u istom projektu, otvori *APIs & Services → Library*, nađi **YouTube Data API v3** i klikni *Enable*.
2. *Credentials → Create credentials → API key*. Preporuka: u *API restrictions* ograniči ključ samo na YouTube Data API v3.
3. Na Renderu dodaj varijablu `YOUTUBE_API_KEY` s tim ključem i ponovo pokreni deploy.

Besplatna dnevna kvota je 10.000 jedinica, a jedna pretraga košta 100, što je oko 100 pretraga dnevno za sve zajedno. Aplikacija ograničava svaku osobu na 10 pretraga u minuti. Ključ ostaje na serveru i ne šalje se pregledniku. Pušta se samo video koji vlasnik dozvoljava ugrađivanje; YouTube prikazuje i svoje reklame.

## Ograničenja

- Sobe, chat i stanje videa čuvaju se u memoriji servera: nestaju pri restartu, a prazne sobe se brišu nakon 6 sati.
- Glas je mesh (svako sa svakim), pa je dobar za nekoliko ljudi. Soba je ograničena na 12 članova.
- Slušalice su obavezne ako gledate film na zvučnike, inače se film čuje kroz mikrofon kao jeka.
- Film mora biti nešto što smijete streamati: vlastiti fajl, javno dostupan ili licenciran sadržaj. Aplikacija ne hostuje filmove, samo sinhronizuje reprodukciju linka ili lokalnog fajla.
- Neki hostovi videa blokiraju ugrađivanje u tuđe stranice, pa link neće svirati.
