# Passdroid Next v3.1.4 - Propuesta de rediseño

Mockup de referencia: `mockup.html` (misma carpeta). Los tokens de este documento usan los mismos nombres que el mockup.

## 1. Lenguaje de diseño compartido por las dos referencias

| Rasgo | mousejiggler | HisenseApiController | Qué tomamos para Passdroid |
|---|---|---|---|
| Tema | Oscuro único, azul-marino (#1a1a2e) | Oscuro único, verde-negro (#111510) | Oscuro **y** claro; el oscuro es navy (coherente con el fondo del icono de Passdroid) |
| Superficies | Escala de 4 pasos + borde de 1 px, sin gradientes | Superficie/elevada + línea, gradientes verticales sutiles, brillo inset superior | Escala de 4 pasos (`surface-0..3`) + borde 1 px + brillo inset de 1 px (sin gradientes fuertes) |
| Acento | Un azul para controles, un verde para "activo" | Un único lima (#d9ee83), texto oscuro sobre él | **Un único acento ámbar** (el de la caja fuerte del icono) con texto navy oscuro encima; verde solo como semántica de estado |
| Tipografía | Segoe UI Variable, pesos 400/500, tamaños pequeños | UI sans + **titulares serif (Palatino)**, eyebrows en mayúsculas 10 px | Segoe UI Variable para UI, Palatino/Georgia para titulares, eyebrows en mayúsculas |
| Radios | 6-8 px controles, 12 px tarjetas | 6-7 px controles, 12-16 px tarjetas/secciones, 999 px pills | 8 / 12 / 16 / 999 |
| Elemento protagonista | Perilla circular de 96 px con anillo pulsante | Sidebar con barra de selección de 3 px con glow | Perilla de candado en el desbloqueo; barra ámbar de 3 px en filas y navegación seleccionadas |
| Movimiento | 150-300 ms, anillo pulsante | `rise-in` 8 px, hover que eleva 2 px, tecla que se hunde, `prefers-reduced-motion` | Todo junto, cortos y discretos |
| Ventana | Frameless con barra propia de 36 px | Frameless en el popup, con fijar encima | Barra propia de 36 px en Windows (ver riesgos) |
| Iconos | lucide, trazo 2 | lucide, trazo 2 | Ya los usamos; se eliminan los emojis |

### Dónde difieren y qué elegimos

1. **Paleta de fondo y acento: navy + ámbar (ni el azul de mousejiggler ni el lima de Hisense).** Ambas referencias usan un tono de superficie propio acoplado al icono de la app (cursor rojo-azul sobre #1a1a2e; monitor sobre lima). El icono de Passdroid es una caja fuerte ámbar sobre azul marino, así que seguimos la misma regla: la paleta sale del icono. Se reutiliza la **estructura** (4 superficies, un acento, verde de estado), no los colores. Ventaja extra: el azul de mousejiggler (#0078d4) chocaría con el ámbar; con un solo acento la UI es más sobria.
2. **Modo claro.** Ninguna referencia lo tiene, pero Passdroid ya lo soporta y es requisito. Se diseña como espejo: fondo azulado muy claro, texto navy, ámbar con texto oscuro; el color de texto ámbar sobre claro se oscurece (#8f5a00) para contraste.
3. **Chrome de ventana.** Mousejiggler es frameless con bandeja; Hisense usa barra nativa en la ventana principal. Elegimos barra propia **solo en escritorio** y como paso opcional y separable (ver riesgos), porque aporta la consistencia visual pero toca `tauri.conf.json`.
4. **Navegación.** Hisense usa sidebar de 252 px; mousejiggler es una sola columna. Passdroid desktop pasa a un rail de 224 px (resuelve la cabecera con 6 iconos sin texto); en móvil se usa barra inferior, que ninguna referencia cubre pero es el patrón nativo de Android.
5. **Serif.** Solo de Hisense. Se limita a titulares y marca (título de pantalla, nombre del vault, título de entrada), nunca a campos ni listas, para no perder legibilidad y mantener la sensación "caja fuerte / editorial".
6. **Animación jiggle de mousejiggler:** descartada (lúdica). **Pulse-ring:** se conserva, solo para sincronización y para la perilla bloqueada.

## 2. Sistema de diseño propuesto

### 2.1 Colores (tokens CSS, nombres sugeridos)

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--bg` (surface-0) | #f2f4f8 | #0f1a2e | Fondo de app |
| `--s1` (surface-1) | #ffffff | #16233b | Paneles, rail, barra de título, modales |
| `--s2` (surface-2) | #f6f8fb | #1d2d49 | Botón reposo, fila hover/seleccionada, toast (claro) |
| `--s3` (surface-3) | #e9eef5 | #263a5c | Hover, pista de toggle apagado, toast (oscuro) |
| `--field` | #ffffff | #0d1628 | Fondo de inputs (más oscuro que la superficie en dark, efecto "hundido") |
| `--border` | #d5dce8 | #2c4166 | Bordes 1 px |
| `--border-h` | #b5c1d6 | #3d5782 | Borde en hover |
| `--text` | #14213a | #eef2f9 | Texto principal |
| `--text2` | #4a5b78 | #b4c2db | Texto secundario / iconos |
| `--muted` | #66758f | #8496b6 | Etiquetas, descripciones (>= 4.5:1 sobre `--s1`) |
| `--accent` | #eeb02c | #f0b73f | Botón primario, barra de selección, toggle activo, foco |
| `--accent-h` | #f5be45 | #f7c95f | Hover del primario |
| `--accent-ink` | #1a2236 | #1a2236 | Texto sobre ámbar |
| `--accent-text` | #8f5a00 | #f0b73f | Ámbar usado como texto/icono sobre superficie |
| `--accent-soft` | #fdf1d4 | rgba(240,183,63,.13) | Fondo de nav activa, tiles |
| `--accent-glow` | rgba(238,176,44,.30) | rgba(240,183,63,.28) | Foco (anillo 3 px) y sombra del primario |
| `--ok` / `--ok-soft` | #0f8a5f / #dcf5ea | #34d399 / rgba(52,211,153,.13) | Desbloqueado, sincronizado, contraseña fuerte |
| `--danger` / `--danger-soft` | #c13b3b / #fde8e6 | #ff8a80 / rgba(255,138,128,.12) | Eliminar, errores, conflicto |
| `--warn-soft` / `--warn-text` | #fff4d6 / #7a5200 | rgba(240,183,63,.12) / #f3cf7a | Avisos (FTP sin cifrar, "Débil") |

Reglas: ámbar = acción y selección; verde = estado "ok" únicamente; rojo = destructivo/error. Nunca más de un botón `primary` visible por zona.

### 2.2 Tipografía

- UI: `"Segoe UI Variable","Segoe UI",Inter,system-ui,-apple-system,Roboto,sans-serif` (nativa en Windows y en Android; no se carga ninguna fuente, cero peticiones).
- Titulares: `"Palatino Linotype","Book Antiqua",Palatino,Georgia,"Noto Serif",serif`, peso 400.
- Mono (contraseñas, rutas, generador): `"Cascadia Mono",Consolas,ui-monospace,monospace`.
- Escala: 11 (eyebrow/meta) · 12.5 (secundario) · 13.5 (botones, cuerpo UI) · 14 (cuerpo, inputs) · 17-20 (nombre de vault) · 24 (título de modal) · 28-30 (título de pantalla/entrada).
- Eyebrow: 10.5-11 px, peso 700, mayúsculas, `letter-spacing:1.2px`, color `--muted`.
- Labels de campo: 11 px, peso 700, mayúsculas, `letter-spacing:.9px`.

### 2.3 Radios, sombras, espaciado, movimiento

- Radios: `--r-sm 6` (kbd, tags), `--r-md 8` (botones, inputs, segmentados), `--r-lg 12` (tarjetas, filas agrupadas, toasts), `--r-xl 16` (modales), `--r-full 999` (pills, toggle, botones redondos). Ventana de escritorio: 14.
- Sombras: `--sh-1 0 1px 2px rgba(20,33,58,.07)+inset 0 1px 0 rgba(255,255,255,.7)` (claro) / `0 1px 2px rgba(0,0,0,.35)+inset 0 1px 0 rgba(255,255,255,.05)` (oscuro); `--sh-2 0 8px 22px rgba(20,33,58,.10)` / `0 10px 26px rgba(0,0,0,.35)` (toasts, perilla); `--sh-3 0 22px 55px rgba(20,33,58,.20)` / `0 24px 60px rgba(0,0,0,.55)` (modales, ventana).
- Espaciado: escala de 4 px: 4, 8, 12, 16, 20, 24, 32. Padding de pantalla 24-32 (escritorio) y 16 (móvil). Altura de control: 40 (escritorio), 44-46 (móvil, objetivo táctil). Fila de lista: 60 (escritorio), 64 (móvil).
- Movimiento: hover/color 150 ms; toggle/perilla 250-400 ms con `cubic-bezier(.2,.7,.2,1)`; entrada de modal/toast `rise` (opacity + 8 px) 350 ms; botón al pulsar `translateY(1px)`; pulse-ring 2-2.4 s solo en sync y perilla; spin 1.2 s en el icono de sync. Todo envuelto en `@media (prefers-reduced-motion: reduce)`.

### 2.4 Componentes

- **Botón** (`.btn`): 40 px, radio 8, fondo `--s2`, borde `--border`, hover `--s3` + `--border-h`. **Primario** (`.primary`): fondo `--accent`, texto `--accent-ink`, peso 700, sombra de glow ámbar. **Fantasma** (`.ghost`): sin fondo ni borde. **Peligro** (`.danger`): texto rojo con borde rojo al 38 %, hover `--danger-soft`. **Solo icono** (`.ibtn`): 36 px, transparente, hover `--s3`; variante `.round` para el sync/bloquear móvil.
- **Input** (`.input`): contenedor 40 px, radio 8, fondo `--field`, borde `--border`; foco = borde `--accent` + anillo `0 0 0 3px --accent-glow`. Botones de acción (mostrar/copiar/generar) dentro, a la derecha. Contraseñas en mono con `letter-spacing:1px`. Medidor de fuerza opcional debajo (4 segmentos).
- **Toggle**: 40x22, pista `--s3` apagado / `--accent` encendido, pulgar 16 px (gris en apagado, `--accent-ink` en encendido, para contraste sobre ámbar).
- **Segmentado**: contenedor `--s2` radio 10 con padding 3; opción activa `--s1` (claro) / `--s3` (oscuro) con `--sh-1` e icono en ámbar. Los emojis se sustituyen por iconos Lucide (`Monitor`, `Sun`, `Moon`, `Globe`).
- **Tarjeta de ajuste** (`.card.setting`): tile de 36 px con `--accent-soft`, título 13.5 px/600, descripción 12 px `--muted`, control a la derecha (toggle o botón). Borde se ilumina en hover (`--border-h`).
- **Fila de entrada** (`.entry`): 60 px, radio 10, avatar de 36 px con la inicial en serif sobre un tono derivado del título (hue 0-360 calculado por hash, `hsl(h 55% 50% / .16)`), título 14/600, subtítulo 12.5 `--muted`, badges a la derecha. Hover `--s2`; seleccionada `--s2` + inset 1 px `--border` + **barra ámbar de 3 px** a la izquierda con glow.
- **Badges** (`.pill`): 22 px, radio 999, 11 px/600. Variantes `ok`, `warn` ("Débil", "Sync pendiente"), `bad` ("Conflicto", "Riesgo"), `line` (neutral con borde). Punto de estado de 6 px con glow para `ok`.
- **Modal** (`.modal`): radio 16, `--s1`, `--sh-3`, backdrop `rgba(6,11,22,.55)` + blur 2 px. Cabecera: eyebrow + título serif 24 + **una sola X**; se elimina el botón "Cerrar" del pie (pies solo con acciones reales).
- **Toast** (`.toast`): ancho máx. 380, radio 12, `--s2/--s3`, icono circular de 28 px tintado (ok/err/sync), título 13.5/700 + una línea de detalle (sin repetir el texto), X, barra de progreso de 3 px que representa el auto-cierre de 5 s. Escritorio: abajo a la derecha; móvil: arriba, sobre la safe-area, para no tapar la barra inferior.
- **Barra superior / de título** (escritorio): 36 px, `--s1`, borde inferior; logo 18 px, nombre, controles 44x36 con cierre en rojo (#e5484d) en hover. Pill con el nombre del vault abierto.
- **Pestañas de ajustes**: texto 13/600, icono 14 px, activa con subrayado ámbar de 2 px y texto `--text`; sin fondo de bloque. En móvil con scroll horizontal si no caben, mínimo 12 px (hoy bajan a 11).
- **Perilla de bloqueo** (`.knob`): 104 px, gradiente radial `--s3 -> --s2`, borde `--border-h`, candado de 40 px con trazo 2.5. Bloqueada: icono ámbar + anillo pulsante muy sutil. Al desbloquear (animación 400 ms) pasa a `--ok` con `Unlock` blanco y glow verde, y se entra al vault.

## 3. Cambios por pantalla

### Inicio / "Vaults disponibles"
- Cabecera con logo 64 px, eyebrow "Gestor de contraseñas" y "Passdroid Next" en serif 30.
- **Los vaults van primero**: lista agrupada en una tarjeta (filas de 64 px: tile de vault, nombre, ruta abreviada en `--muted`, pill de estado Sync/Local/Pendiente, papelera, chevron). Clic en la fila = desbloquear.
- Una única fila de 3 acciones debajo: **Nuevo vault** (primario), Abrir fichero, Vincular por QR (secundarios). Desaparece la tarjeta QR intercalada. "Nuevo vault" abre su formulario en un modal (deja de ser un panel permanente de la página; los dos campos de contraseña y el selector de fichero van ahí). En Android "Abrir fichero" se llama "Importar" como hoy.
- Pie: línea de seguridad con icono `ShieldCheck`.
- Estado vacío (sin vaults recientes): `ShieldCheck` o logo grande, título serif "Crea tu primer vault" y botón primario.

### Desbloqueo
- Perilla con candado centrada, eyebrow "Vault bloqueado", nombre del vault en serif 28, ruta en mono.
- Campo de contraseña con icono `KeyRound` y ojo; "Desbloquear" a ancho completo (primario, 44 px), "Cancelar" fantasma.
- Pie con punto ámbar "Bloqueado". Error de contraseña: borde y texto en `--danger`, sin toast duplicado.

### Vault en escritorio (lista + editor)
- Cabecera de 6 iconos -> **rail lateral de 224 px**: icono + nombre del vault + nº de entradas; navegación con texto (Entradas, Generador, Sincronizar con punto de estado), sección "Datos" (Importar, Exportar, Ajustes); pie con estado de sync ("Sincronizado - hace 2 min") y botón **Bloquear** con texto. El elemento activo lleva fondo `--accent-soft` y barra ámbar. "Sincronizar" solo aparece si hay sync activo.
- Columna de lista de 320 px: título "Entradas" en serif, botón "Nueva" (primario pequeño), buscador, filas con avatar/inicial, badges Conflicto y Débil (esta última requiere un cálculo de fuerza, ver riesgos), pie con contador y orden.
- Editor: cabecera con avatar grande, eyebrow "Editar entrada", título serif 28 y pill de fuerza; cuerpo en rejilla de 2 columnas (título y URL/notas a ancho completo); la contraseña con mostrar, copiar y generar y medidor de 4 segmentos; **barra de acciones fija abajo**: Guardar (primario), Descartar, fecha de modificación y Eliminar (peligro) a la derecha.

### Móvil: lista y editor a pantalla completa
- Lista: cabecera con tile del vault, nombre en serif 20, estado de sync y dos botones redondos (Sincronizar con pulse-ring mientras sincroniza, Bloquear); buscador de 44 px; filas de 64 px; **FAB ámbar** "Nueva entrada"; **barra inferior** (Entradas, Generador, Exportar, Ajustes) con indicador ámbar superior y `padding-bottom: env(safe-area-inset-bottom)`.
- Editor: cabecera propia (Volver, eyebrow + nombre de la entrada, papelera), campos de 46 px en una columna, y **barra de acciones fija** abajo con Descartar y Guardar. Resuelve el punto débil nº 10 (editor sin cabecera con nombre).

### Ajustes (pestañas)
- Modal de 520 px, cabecera "Ajustes" con eyebrow, una X; pestañas con icono y subrayado ámbar (General, Sync, Seguridad).
- General: segmentados de Tema (Sistema/Claro/Oscuro con iconos) e Idioma, y el selector de icono de vault como tarjeta de ajuste con vista previa.
- Sync: tarjeta de ajuste con toggle "Sincronización automática"; segmentado FTPS/FTP (FTPS con escudo); servidor/puerto, usuario/contraseña; callout ámbar para FTP sin cifrar; acciones Probar, Guardar (primario), Sincronizar ahora; tarjeta "Vincular otro dispositivo" con botón Mostrar QR.
- Seguridad: campos de cambio de contraseña maestra, con medidor de fuerza en la nueva.

### Exportar, importar y QR
- **Exportar**: dos tarjetas-opción con tile de icono; la cifrada marcada como recomendada, la de XML en claro con tile rojo, pill "Riesgo" y hover de borde rojo.
- **Importar legacy**: selector de fichero y contraseña; vista previa en una tarjeta con filas compactas, contador "50 de N" y botón primario "Importar".
- **QR para mostrar**: QR de 124-280 px en una pastilla blanca (fija, para que escanee), callout ámbar de seguridad, "Copiar configuración". **Escáner**: marco del visor y esquinas en `--accent`, línea láser ámbar, estados de error con `--danger-soft`; los colores fijos (#000, #fff) se mantienen solo donde son necesarios para la cámara/QR.
- **Confirmar quitar reciente**: modal pequeño con texto y dos botones (Cancelar fantasma / Quitar, peligro), no solo el botón rojo.

## 4. Qué se conserva

- `lucide-react` en todos los iconos (se añade solo `Monitor`, `Sun`, `Moon` en lugar de emojis).
- Tema claro/oscuro/sistema con variables CSS y `data-theme` en `<html>` (`ThemeContext` no cambia). Se mantienen los nombres de variables existentes (`--bg`, `--surface`, `--primary`...) como alias para no romper reglas intactas durante la transición.
- i18n (`en.ts`, `es.ts`): los textos nuevos son pocos ("Descartar", "Datos", "Recomendada", etiquetas de badges).
- Breakpoints actuales (900 y 640 px) y la lógica del editor como overlay en móvil.
- Señales de seguridad: aviso de FTP sin cifrar, estilo de peligro en export XML, aviso en el QR, ocultación de contraseña por defecto.

## 5. Alcance de implementación (1-2 días)

**Día 1 (casi todo en `src/styles.css`, riesgo bajo):**
1. Reescribir bloque de tokens `:root` y `:root[data-theme="dark"]` con la paleta de 2.1, añadir `--r-*`, `--sh-*`, `--font-*`; dejar alias de los nombres antiguos.
2. Restyle de componentes base: `.primary-button`, `.secondary-button`, `.ghost-button`, `.danger-button`, `.icon-button`, inputs, `.toggle-row`, `.segmented`, `.panel`, `.modal`, `.modal-backdrop`, `.notice` (toast), `.settings-tabs`, `.entry-row`, `.recent-row`, `.export-option`, `.sync-warning`, `.qr-*` (radios, sombras, foco ámbar).
3. Fondo del body: sustituir los dos degradados verde/naranja por un único glow radial ámbar muy tenue (solo en oscuro).
4. Tipografía: titulares (`h1`, `h2`, nombre del vault, título de modal) a serif; eyebrows y labels en mayúsculas.
5. Movimiento: `rise-in` para modales/toasts y `prefers-reduced-motion`.
6. Tema: añadir `@media (prefers-color-scheme: dark)` para `:root:not([data-theme])`, con lo que el color de sistema se aplica sin esperar al JS (corrige el parpadeo).

**Día 2 (cambios de JSX puntuales):**
1. `App.tsx` pantalla vault: sustituir la fila de 6 iconos por el rail (`<aside class="rail">`) en escritorio y la barra inferior (`<nav class="tabbar">`) en móvil; reutiliza los mismos handlers. Mover el botón Bloquear al pie del rail.
2. Start: reordenar (lista de vaults, fila de 3 acciones) y pasar "Nuevo vault" a modal.
3. Unlock: añadir la perilla (un `div` con `Lock` de 40 px).
4. `Modal`: quitar el botón "Cerrar" del pie; `Toast`: icono + título + detalle, sin duplicar texto.
5. Emojis de segmentados -> iconos Lucide; `aria-label` del selector de iconos con claves i18n; `alt` del QR traducido.
6. Avatar de entrada (inicial + hue por hash) y editor móvil con cabecera propia.

**Opcionales (mismo release o siguiente):** barra de título propia en Windows (`decorations:false` + componente con `data-tauri-drag-region`); indicador de contraseña débil/medidor de fuerza; pulse-ring en el icono de sync.

## 6. Riesgos

1. **Barra de título propia**: afecta a `tauri.conf.json`, arrastre, bordes redondeados/ sombra en Windows 11 y el comportamiento de maximizar/Snap. Mitigación: hacerlo como cambio aislado y opcional; el resto del diseño funciona con la barra nativa (el mockup la dibuja solo para mostrar la intención).
2. **Insignia "Débil" y medidor de fuerza**: no existe hoy un cálculo de fuerza; hay que añadirlo (p. ej. longitud + diversidad de caracteres). Si no entra, se omiten el badge y el medidor sin afectar al resto.
3. **Contraste del ámbar**: el ámbar sobre blanco no cumple como texto; por eso existe `--accent-text` (#8f5a00 en claro). Hay que usarlo siempre que el ámbar sea texto o icono sobre superficie, y `--accent` solo como fondo con `--accent-ink`.
4. **Serif en Android**: Palatino no existe; cae a Noto Serif/Georgia, con otro carácter. Se acepta (solo titulares); si molesta se puede incrustar una fuente serif libre.
5. **Dependencia del JS para el tema**: el CSS de `prefers-color-scheme` mitiga el parpadeo, pero hay que comprobar que `data-theme` explícito siempre gana.
6. **Regresiones visuales por cambio global de tokens y de radios** (hoy casi todo es de radio 0). Revisión manual de todas las pantallas y modales en claro/oscuro, 320, 480, 900 y 1200 px.
7. **Teclado virtual en Android**: la barra de acciones fija del editor móvil y la barra inferior deben ocultarse o subir con el teclado (usar `100dvh` y `env(safe-area-inset-bottom)`).
8. **Blur del backdrop** puede costar rendimiento en móviles modestos: usar solo en escritorio.
9. **Hash de color del avatar**: depende del título; si se renombra la entrada, cambia el color. Aceptable; si no, derivarlo del id.
