# Hugo Sushi

Sitio de [hugosushi.online](https://hugosushi.online/): carta y armador de pedido
de Hugo Sushi (Ushuaia). HTML estático, lo publica GitHub Pages con cada push.

Precios, disponibilidad y pedidos los da la API (`api.hg-vl.com`); la carta
(nombres, descripciones y fotos) está escrita en `index.html`. Para sacar un ítem
de venta: primero sacarlo de acá y publicar, y recién después darlo de baja en la
API — al revés, la página lo sigue ofreciendo y el pedido se rechaza.
