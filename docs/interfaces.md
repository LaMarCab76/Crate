# Interfaces de Crate

Crate mantiene una sola biblioteca, sesión de audio, cola y coordinación de trabajos. Las interfaces cambian su presentación y navegación. La selección se administra desde **Preferencias → Apariencia → Interfaz**.

## Elegir y recuperar un diseño

**Glass** conserva el diseño actual. **Clásica** recupera la composición anterior con las funciones actuales. La selección se guarda por instalación, separada del tema, densidad, audio y biblioteca.

La activación de una interfaz personal comienza como una prueba de 60 segundos. Los dos diseños incluidos se seleccionan directamente. El control de Crate ofrece **Conservar** o **Revertir**. Si vence la prueba, cerrás sin confirmar o falla una interfaz programada, Crate recupera el diseño anterior. La opción de recuperación también está en el menú nativo con `Cmd/Ctrl+Alt+Shift+R`. Las revisiones instaladas son inmutables: podés volver a una revisión desde la galería.

## Crear con el editor

1. Elegí **Crear interfaz** o **Crear una copia** sobre un diseño incluido. Las copias incluidas son composiciones editables inspiradas en esos diseños; el núcleo de los diseños incluidos sigue siendo parte de Crate.
2. Creá pantallas y sus enlaces de navegación. El primer enlace es la pantalla inicial.
3. Agregá filas, columnas, grillas, paneles, pestañas o capas. Seleccioná un contenedor antes de agregar sus hijos.
4. Agregá texto, botones, búsqueda, canciones, álbumes, artistas, reproductor, cola, letras o una pantalla compartida de Crate.
5. Usá el inspector para configurar dimensiones, separación, colores, tipografía, alineación, datos y acciones. Podés reordenar con los botones Subir/Bajar y cambiar el contenedor desde «Mover a».
6. Cambiá entre selección e interacción, tamaños del lienzo y estados con música, vacío, carga y error. La vista previa usa datos ficticios: no reproduce audio ni modifica la biblioteca.
7. **Instalar revisión** valida y guarda sin activarla. **Instalar y probar** inicia una selección provisional.

Los borradores se autoguardan en almacenamiento local del renderer, por separado de las revisiones instaladas. Se conservan hasta 20 borradores y 2 MB en total. Las instrucciones de diseño se guardan por interfaz, con hasta 20 entradas y 64 KB en total. Un borrador dañado se ignora. El historial mantiene hasta 50 pasos o 4 MB; los campos de texto conservan además el deshacer nativo mientras tienen foco. `Cmd/Ctrl+Z` y `Cmd/Ctrl+Shift+Z` controlan el historial cuando el foco está fuera de un campo editable. Si el almacenamiento está lleno, se muestra el fallo de autoguardado; instalar una revisión conserva una copia en el administrador de paquetes.

Las interfaces de código se editan como archivos y como manifiesto JSON. Un programa arbitrario no se convierte automáticamente en un árbol visual.

## Crear a partir de instrucciones

El editor incluye un brief copiable para trabajar con un desarrollador o una IA. La generación se realiza en ese entorno de desarrollo; Crate recibe, valida y prueba el paquete terminado. No requiere claves de una IA ni envía instrucciones o datos de la biblioteca a servicios externos.

Las instrucciones se autoguardan por interfaz, separadas del manifiesto y sus descripciones. Se conservan hasta 20 briefs con un límite total de 64 KB; si se supera o falla el almacenamiento, el editor muestra el error para que puedas copiar el texto antes de cerrar.

Usá este encargo como punto de partida:

```text
Crear una interfaz para Crate según docs/interfaces.md y shared/types/interfaces.ts.
Objetivo: colección centrada en carátulas y una pantalla de escucha tranquila.
Referencias: describir o adjuntar las referencias visuales concretas.
Pantallas: Colección, Escuchando, Cola y acceso a Preferencias.
Navegación: pestañas superiores; reproducir no debe cambiar de pantalla.
Componente nuevo: tarjeta de canción con carátula, título, artista y Agregar a cola.
Colores: fondo #111a1d, panel #19262a, acento #99d7c4.
Tipografía: sistema; título 30 px, cuerpo 13 px.
Tamaños: desde 900 × 600; evitar contenido oculto tras el reproductor.
Estados: biblioteca vacía, búsqueda sin resultados, carga y errores del SDK.
Accesibilidad: etiquetas, orden de foco, teclado y movimiento reducido.
Entrega: paquete JSON .crate-interface autocontenido y fuentes editables.
Aceptación: buscar, reproducir, pausar, avanzar, navegar y recuperar el diseño anterior.
No usar window.api, Node, Electron, red, instalaciones ni recursos remotos.
```

## Formato del paquete

Un `.crate-interface` es un documento JSON UTF-8 autocontenido, no un ZIP ni un instalador:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "id": "mi-interfaz",
    "name": "Mi interfaz",
    "version": "1.0.0",
    "kind": "declarative",
    "base": "glass",
    "capabilities": ["library.read", "playback.control", "navigation"],
    "theme": { "background": "#111a1d", "accent": "#99d7c4" },
    "screens": [{
      "id": "home",
      "title": "Colección",
      "root": { "id": "root", "type": "column", "props": { "padding": 24, "gap": 20 }, "children": [
        { "id": "title", "type": "text", "props": { "text": "Tu música", "fontSize": 30 } },
        { "id": "search", "type": "search" },
        { "id": "player", "type": "player" },
        { "id": "albums", "type": "albums", "props": { "limit": 36, "minWidth": 140 } }
      ] }
    }],
    "navigation": [{ "id": "nav-home", "label": "Colección", "screenId": "home" }]
  }
}
```

`id` usa minúsculas, números y guiones; no se pueden instalar paquetes con los IDs reservados `crate-glass` y `crate-classic`. `version` utiliza `major.minor.patch`. Cada guardado conserva una revisión identificada por contenido, incluso si mantiene el mismo número de versión.

El validador admite hasta 16 MiB por paquete, 256 archivos, 32 pantallas, 1000 componentes y 20 niveles de anidación. Rechaza rutas relativas que salen del paquete, archivos faltantes, claves reservadas, identificadores repetidos, capacidades desconocidas y navegación a pantallas inexistentes. El contrato ejecutable de validación es `shared/interfaces/validation.ts`.

### Componentes declarativos

| Tipo | Uso | Propiedades principales |
| --- | --- | --- |
| `row`, `column`, `panel` | Composición y contenedores | `gap`, `padding`, `align`, `justify`, `width`, `height` |
| `grid` | Grilla | `columns`, `gap`; pasa a una columna por debajo de 640 px |
| `tabs` | Pestañas con teclado | Cada hijo usa su `title` como etiqueta |
| `stack` | Capas superpuestas | Los hijos comparten el área de la grilla; el último queda encima |
| `text` | Texto | `text`, `fontSize`, `fontWeight`, `color` |
| `button` | Acción | `text`, `action`, `target` |
| `search` | Buscar en canciones de esta interfaz | Consulta local compartida por canciones, álbumes y artistas |
| `tracks` | Lista de canciones | `data`: `library` o `favorites`; `limit` (tamaño de página), `title`, `emptyText` |
| `albums`, `artists` | Colecciones navegables | `limit`, `minWidth`, `title`, `emptyText` |
| `player` | Canción actual, transporte, posición y volumen | `compact` |
| `queue` | Cola y reproducción por posición | `limit` (tamaño de página), `title`, `emptyText` |
| `lyrics` | Letras actuales gestionadas por Crate | Vista nativa compartida |
| `host-view` | Pantalla de Crate | `target` con una ruta nativa |
| `spacer` | Espacio flexible | `height` |

Propiedades compartidas: `radius`, `background`, `color`, `minWidth` y `hideBelow: 640`. Los estilos son valores escalares de una lista acotada; no se aplican reglas CSS arbitrarias sobre la aplicación. Los tokens del tema son `background`, `surface`, `text`, `muted`, `accent` y `font-family`.

Acciones de botones: `navigate`, `togglePlay`, `next`, `previous`. Destinos: `screen:ID` o rutas nativas `library`, `albums`, `artists`, `genres`, `recent`, `settings`, `devices`, `import`, `duplicates`, `album:ID`, `artist:ID`, `playlist:ID`. Conservá los IDs devueltos por los datos; no inventes prefijos para entidades.

El componente `queue` requiere `library.read` para mostrar metadatos y `queue.control` para saltar entre canciones. `host-view` abre una superficie de Crate administrada por el host, con sus confirmaciones y herramientas habituales, mediante la capacidad `navigation`.

Las listas y colecciones declarativas muestran hasta 200 elementos por página, con controles para recorrer todos los resultados. Para una biblioteca completa con todas sus herramientas, usá `host-view` o consultas paginadas en una interfaz programada.

## Programar pantallas y componentes nuevos

Para `kind: "code"`, el manifiesto declara `entry: "index.html"`. Los recursos se incluyen en `files`:

```json
{
  "manifest": { "schemaVersion": 1, "id": "hello-crate", "name": "Hello", "version": "1.0.0", "kind": "code", "base": "classic", "capabilities": ["navigation"], "entry": "index.html" },
  "files": [{ "path": "index.html", "encoding": "utf8", "content": "<!doctype html><html lang='es'><body><button id='settings'>Preferencias</button><script>document.getElementById('settings').onclick=()=>window.crateInterface.request('navigation.openSettings')</script></body></html>" }]
}
```

Los archivos pueden usar `utf8` o `base64`. HTML, CSS, JavaScript, fuentes e imágenes deben estar dentro del paquete. Podés compilar React u otra biblioteca a archivos estáticos previamente. Crate no ejecuta scripts de instalación, no resuelve dependencias y no descarga recursos.

El código tiene un `WebContentsView` con sesión efímera, sandbox y aislamiento de contexto. No recibe Node, Electron, `window.api`, archivos locales, permisos de dispositivos, ventanas nuevas ni conexión de red. Solo recibe este SDK:

```js
const page = await window.crateInterface.request('library.tracks', {
  offset: 0, limit: 48, query: 'jazz'
})
const dispose = window.crateInterface.onState(snapshot => {
  console.log(snapshot.playback.status)
})
window.addEventListener('pagehide', dispose, { once: true })
```

Toda promesa puede fallar: mostrá el error sin perder el resto de la pantalla. Las suscripciones deben liberarse. No consultes la biblioteca en cada actualización de progreso. La app limita el ritmo y tamaño de los mensajes del SDK.

Durante el arranque, las consultas de biblioteca esperan su primera carga. Si esa carga falla, el SDK devuelve un error para que la interfaz permita reintentar.

El estado se publica como máximo cinco veces por segundo. Incluye `playback`
(estado, canción actual, posición, duración y volumen), `queue` (hasta 250
canciones, total, índice y modos) y la ruta actual. Sin `library.read`, la
canción actual es `null` y la lista de canciones de la cola está vacía; sólo se
publican tiempos, estado, volumen, cantidades, modos y ruta. Las consultas de
biblioteca siguen requiriendo la capacidad declarada.

Para una cola con más de 250 canciones, consultá `queue.list` con `{offset, limit}`
y la capacidad `library.read`. Devuelve una página de canciones más `currentIndex`,
`shuffle` y `repeat`; así la interfaz puede recorrer la cola completa sin recibirla
en cada actualización de progreso.

### Capacidades

| Capacidad | Métodos |
| --- | --- |
| `library.read` | `library.trackCount`, `tracks`, `albums`, `artists`, `playlists`, `albumTracks`, `artistTracks`, `playlistTracks`, `search`; `queue.list` |
| `playback.control` | `playback.toggle`, `play`, `pause`, `next`, `previous`, `seek`, `volume`, `playTrack` |
| `queue.control` | `queue.add`, `play`, `remove`, `clear` |
| `navigation` | `navigation.go`, `navigation.openSettings` |

Los métodos de biblioteca llevan el prefijo `library.`. Consultas de colecciones: `{offset,limit,query?}`; resultados: `{items,total,offset,limit}`. `limit` admite de 1 a 250. Las consultas de temas de álbum/artista/playlist agregan `{id}`. `library.search` devuelve `{tracks,albums,artists}`, cada uno con esa estructura de página.

Una canción tiene `{id,title,artist,album,albumId,duration,format,quality,loved,artworkUrl?}`. `duration` son segundos; `id` puede ser numérico o texto. No se exponen rutas de los archivos de audio. Las carátulas se sirven con `crate://artwork/…`.

Parámetros de acciones:

```js
await sdk.request('playback.playTrack', { trackId })
await sdk.request('playback.seek', { positionSec: 42 })
await sdk.request('playback.volume', { volume: 0.7 }) // 0..1
await sdk.request('queue.add', { ids: [trackId] }) // 1..250 IDs
await sdk.request('queue.play', { ids: [firstId, secondId] })
await sdk.request('queue.play', { index: 2 })
await sdk.request('queue.remove', { index: 2 })
await sdk.request('queue.clear')
await sdk.request('navigation.go', { route: 'album', id: albumId })
await sdk.request('navigation.openSettings')
```

El estado se publica hasta cinco veces por segundo:

```js
{
  playback: { status, currentTrack, positionSec, durationSec, volume },
  queue: { tracks, total, currentIndex, shuffle, repeat },
  route
}
```

`queue.tracks` incluye hasta 250 elementos; `total` conserva el tamaño completo. Al navegar a una pantalla nativa, Crate la abre con sus herramientas habituales y mantiene disponible el acceso a la interfaz personal.

## Ejemplo ejecutable

`examples/interfaces/nightdesk.crate-interface` es importable directamente. Sus fuentes están en `examples/interfaces/nightdesk/`. Implementa un componente de tarjeta nuevo, tres pantallas, búsqueda paginada, transporte real y administración de cola.

Para reconstruir el paquete tras editar sus fuentes:

```sh
node examples/interfaces/pack.mjs
```

También hay un paquete declarativo de ejemplo en `examples/interfaces/collection.crate-interface`.

## Verificación de una interfaz

1. Importá el paquete y revisá nombre, versión y capacidades.
2. En el editor declarativo, probá datos de muestra, vacío, carga y error, y 900/1280 px.
3. Activá en prueba. Verificá que la canción, posición, volumen y cola se conservan.
4. Recorré cada pantalla con mouse y teclado. Probá biblioteca vacía, búsquedas sin resultados, carátulas faltantes y errores del SDK.
5. Verificá ventana mínima y amplia, contraste, foco, nombres accesibles y movimiento reducido.
6. Abrí Preferencias y diálogos nativos desde la interfaz. Usá Revertir y comprobá la recuperación.
7. Conservá el diseño, reiniciá y comprobá la selección persistida. Probá una revisión anterior desde la galería.

La compilación y las pruebas de contrato verifican estructura y código. La aceptación de una interfaz necesita además este recorrido en la aplicación real.

### Smoke reproducible de la aplicación real

Con las dependencias y bibliotecas nativas de Crate preparadas:

```sh
npm run build
node scripts/smoke-interfaces.mjs
```

El smoke inicia la aplicación construida con su preload e IPC reales, usando un perfil nuevo y dos archivos WAV silenciosos temporales. Solo sustituye el diálogo del sistema para elegir esas rutas conocidas. Recorre la configuración inicial, reproducción, ambos diseños, editor, borradores e instrucciones, importación, controles del SDK, recuperación y temas claro/oscuro a 900 × 600. Después cierra la app normalmente y abre otro proceso con el mismo perfil para comprobar la interfaz programada confirmada y la biblioteca al arrancar en frío.

El perfil, los WAV y el bootstrap se eliminan al terminar. Las capturas reales y los resultados quedan en la carpeta `/private/tmp/crate-interface-ui-evidence-…` impresa por el script. El smoke da foco a la ventana y la redimensiona un píxel antes de capturar, para renovar superficies que macOS mantiene por oclusión; conserva la política de throttling de producción. No utiliza el catálogo ni la instalación del usuario.

Para repetir la prueba automatizada de la aplicación completa, ejecutá `npm run build` y luego `npm run smoke:interfaces`. Usa un perfil y dos archivos WAV silenciosos temporales, abre una ventana real de Electron y conserva capturas y resultados en la ruta que imprime al terminar. Necesita acceso a la sesión gráfica de macOS. `npm run smoke:interface-runtime` comprueba además el aislamiento y la recuperación de las interfaces programadas con un perfil temporal.
