# Font Awesome Free (solid), shipped with U2OS

- Version 6.5.2, `fa-solid-900.woff2` from <https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/>.
- Licence: see `LICENSE.txt` (icons CC BY 4.0, font SIL OFL 1.1, code MIT). Attribution to Fonticons, Inc.
- Served locally on purpose: the Content-Security-Policy allows only `'self'`, and a CDN would make every page view contact a third party.
- `public/styles/icons.css` lists only the codepoints U2OS uses. To add an icon, find its codepoint in the Font Awesome Free 6.5.2 stylesheet and add one `.u2-icon--name::before` rule.
