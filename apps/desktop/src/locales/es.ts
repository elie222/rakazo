export const ES_MESSAGES: Record<string, string> = {
  // Menus
  "About {name}": "Acerca de {name}",
  "Check for Updates…": "Buscar actualizaciones…",
  "Computer Access…": "Acceso a la computadora…",
  "Revoke Local Computer Access": "Revocar el acceso a la computadora local",
  "Change Rakazo Server…": "Cambiar servidor de Rakazo…",
  "Stop Local Stack": "Detener stack local",
  "Hide {name}": "Ocultar {name}",
  "Hide Others": "Ocultar otros",
  "Show All": "Mostrar todo",
  "Quit {name}": "Salir de {name}",
  File: "Archivo",
  Exit: "Salir",
  Quit: "Salir",
  Edit: "Edición",
  Undo: "Deshacer",
  Redo: "Rehacer",
  Cut: "Cortar",
  Copy: "Copiar",
  Paste: "Pegar",
  "Paste and Match Style": "Pegar y adaptar estilo",
  Delete: "Eliminar",
  "Select All": "Seleccionar todo",
  Speech: "Voz",
  "Start Speaking": "Iniciar locución",
  "Stop Speaking": "Detener locución",
  View: "Visualización",
  "Actual Size": "Tamaño real",
  "Zoom In": "Ampliar",
  "Zoom Out": "Reducir",
  "Toggle Full Screen": "Pantalla completa",
  Window: "Ventana",
  Minimize: "Minimizar",
  Zoom: "Zoom",
  Close: "Cerrar",
  "Close Window": "Cerrar ventana",
  "Bring All to Front": "Traer todo al frente",

  // Updates
  "Rakazo {version} is ready to install.": "Rakazo {version} está listo para instalarse.",
  Restart: "Reiniciar",
  Later: "Más tarde",
  "Could not install the update.": "No se pudo instalar la actualización.",
  "Could not check for updates.": "No se pudieron buscar actualizaciones.",
  "Rakazo is up to date.": "Rakazo está actualizado.",
  "Version {version}": "Versión {version}",
  "Automatic updates are turned off for this install.":
    "Las actualizaciones automáticas están desactivadas en esta instalación.",
  "Automatic updates only run in an installed build.":
    "Las actualizaciones automáticas solo funcionan en una versión instalada.",
  "No desktop releases are published for this build yet.":
    "Todavía no hay versiones de escritorio publicadas para esta compilación.",
  "Move Rakazo to Applications to install updates.":
    "Mueve Rakazo a Aplicaciones para instalar actualizaciones.",
  "Free up disk space to install updates.":
    "Libera espacio en el disco para instalar actualizaciones.",
  "This update could not be verified. Reinstall Rakazo from a trusted download.":
    "No se pudo verificar esta actualización. Vuelve a instalar Rakazo desde una descarga de confianza.",
  "The update could not be completed. Try again later.":
    "No se pudo completar la actualización. Inténtalo de nuevo más tarde.",
  "Could not reach the update server.": "No se pudo conectar con el servidor de actualizaciones.",

  // Computer access
  "Allow local computer access?": "¿Permitir el acceso a la computadora local?",
  "Allow bots to use this computer?": "¿Permitir que los bots usen esta computadora?",
  Cancel: "Cancelar",
  Allow: "Permitir",
  "Bots on {host} can run commands, read and change files, and launch apps with your account’s permissions. You can revoke access in Settings.":
    "Los bots de {host} pueden ejecutar comandos, leer y cambiar archivos y abrir apps con los permisos de tu cuenta. Puedes revocar el acceso en Configuración.",
  "Bots on this local instance can run commands, read and change files, and launch apps with your account’s permissions. You can revoke access from the app menu.":
    "Los bots de esta instancia local pueden ejecutar comandos, leer y cambiar archivos y abrir apps con los permisos de tu cuenta. Puedes revocar el acceso desde el menú de la app.",
  "Local computer access requires an app-managed local instance.":
    "El acceso a la computadora local requiere una instancia local administrada por la app.",
  "Local server is unavailable": "El servidor local no está disponible",

  // Browser sign-in
  "A sign-in attempt is already active. Cancel it and retry.":
    "Ya hay un inicio de sesión en curso. Cancélalo y vuelve a intentarlo.",
  "Could not open browser sign-in. Close other sign-in attempts and retry.":
    "No se pudo abrir el inicio de sesión en el navegador. Cierra los otros intentos de inicio de sesión y vuelve a intentarlo.",
  "Sign-in callback rejected. Return to Rakazo to retry.":
    "Se rechazó la respuesta del inicio de sesión. Vuelve a Rakazo para intentarlo de nuevo.",
  "You can close this tab and return to Rakazo.": "Puedes cerrar esta pestaña y volver a Rakazo.",

  // Setup window
  "Set up Rakazo": "Configurar Rakazo",
  "Quit Rakazo": "Salir de Rakazo",
  "Welcome to Rakazo": "Te damos la bienvenida a Rakazo",
  "Choose which server this app should use.": "Elige qué servidor debe usar esta app.",
  Instance: "Instancia",
  "This computer": "Esta computadora",
  "Existing instance": "Instancia existente",
  "Technical details": "Detalles técnicos",
  "Setup progress": "Progreso de la configuración",
  "Server address": "Dirección del servidor",
  Headers: "Encabezados",
  "Name: value": "Nombre: valor",
  "Check connection": "Comprobar conexión",
  Continue: "Continuar",
  "Check again": "Volver a comprobar",
  Retry: "Reintentar",
  "Getting ready…": "Preparando…",
  "Downloading Rakazo…": "Descargando Rakazo…",
  "Starting Rakazo…": "Iniciando Rakazo…",
  "Almost ready…": "Casi listo…",
  "Rakazo is ready.": "Rakazo está listo.",
  "{size} downloaded": "{size} descargados",
  "Connecting…": "Conectando…",
  "Checking…": "Comprobando…",
  "Rakazo answered at {url}.": "Rakazo respondió en {url}.",
  "Enter a server address first.": "Primero introduce la dirección de un servidor.",
  "Could not save that address.": "No se pudo guardar esa dirección.",
  "Could not save that address. Try again.":
    "No se pudo guardar esa dirección. Inténtalo de nuevo.",
  "Could not follow the local stack. Try again.":
    "No se pudo seguir el stack local. Inténtalo de nuevo.",
  "Could not start the local stack. Try again.":
    "No se pudo iniciar el stack local. Inténtalo de nuevo.",
  "Could not run the connection check. Try again.":
    "No se pudo comprobar la conexión. Inténtalo de nuevo.",
  "Setup bridge unavailable.": "El puente de configuración no está disponible.",
  "Setup could not start. Quit Rakazo and try again.":
    "No se pudo iniciar la configuración. Sal de Rakazo e inténtalo de nuevo.",

  // Connecting to a server
  "Enter a server address.": "Introduce la dirección de un servidor.",
  "Enter a valid http:// or https:// address.":
    "Introduce una dirección http:// o https:// válida.",
  "Enter a valid server address. Public servers require HTTPS; a new local instance must use localhost.":
    "Introduce una dirección de servidor válida. Los servidores públicos requieren HTTPS; una nueva instancia local debe usar localhost.",
  "Invalid custom headers": "Encabezados personalizados no válidos",
  "That address redirects elsewhere. Enter the final Rakazo server address.":
    "Esa dirección redirige a otro lugar. Introduce la dirección final del servidor de Rakazo.",
  "That address did not respond like a Rakazo server.":
    "Esa dirección no respondió como un servidor de Rakazo.",
  "The server answered with HTTP {status}.": "El servidor respondió con HTTP {status}.",
  "Timed out reaching that address.": "Se agotó el tiempo al intentar acceder a esa dirección.",
  "Nothing is listening at that address yet.": "Todavía no hay nada escuchando en esa dirección.",
  "That host could not be found.": "No se encontró ese host.",
  "The server's HTTPS certificate was rejected.": "Se rechazó el certificado HTTPS del servidor.",
  "Could not reach that address.": "No se pudo acceder a esa dirección.",
  "A connection attempt is already running.": "Ya hay un intento de conexión en curso.",
  "Could not open that server. {detail}": "No se pudo abrir ese servidor. {detail}",
  "Could not reconnect to the saved server. {detail}":
    "No se pudo volver a conectar con el servidor guardado. {detail}",
  "The server page did not become ready.": "La página del servidor no llegó a estar lista.",
  "Page failed to load.": "No se pudo cargar la página.",
  "Renderer stopped ({reason}).": "El renderizador se detuvo ({reason}).",
  "Renderer stopped after load.": "El renderizador se detuvo después de cargar.",
  "Could not open that server. Renderer stopped.":
    "No se pudo abrir ese servidor. El renderizador se detuvo.",
  "Could not open that server. Renderer stopped. The previous instance was restored for the next launch.":
    "No se pudo abrir ese servidor. El renderizador se detuvo. Se restauró la instancia anterior para el próximo inicio.",
  "Could not open that server. The previous instance was left unchanged.":
    "No se pudo abrir ese servidor. La instancia anterior no se modificó.",
  "Could not save setup. The previous instance was restored.":
    "No se pudo guardar la configuración. Se restauró la instancia anterior.",
  "Connected, but could not save setup for the next launch. Try Continue again.":
    "Se conectó, pero no se pudo guardar la configuración para el próximo inicio. Vuelve a pulsar Continuar.",
  "The app-managed Rakazo services are not ready. Retry setup.":
    "Los servicios de Rakazo que administra la app no están listos. Vuelve a intentar la configuración.",

  // Docker
  "Docker is not installed on this computer.": "Docker no está instalado en esta computadora.",
  "Docker is installed, but Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin.":
    "Docker está instalado, pero falta Docker Compose. Instala Docker Desktop o docker-compose-plugin.",
  "Could not check Docker Compose. Check the output below, then retry.":
    "No se pudo comprobar Docker Compose. Revisa la salida de abajo y vuelve a intentarlo.",
  "Docker is installed but not running. Start Docker, then check again.":
    "Docker está instalado, pero no está en funcionamiento. Inicia Docker y vuelve a comprobar.",
  "This user cannot access Docker. Add it to the docker group (sudo usermod -aG docker $USER), sign out and back in, then check again.":
    "Este usuario no puede acceder a Docker. Agrégalo al grupo docker (sudo usermod -aG docker $USER), cierra sesión, vuelve a iniciarla y vuelve a comprobar.",
  "The start was interrupted. Retry to continue.":
    "Se interrumpió el inicio. Vuelve a intentarlo para continuar.",
  "Images for {tag} are not published yet. Try again in a few minutes.":
    "Las imágenes de {tag} aún no están publicadas. Inténtalo de nuevo en unos minutos.",
  "Could not bind a local port after retrying. Retry to choose another port.":
    "No se pudo usar un puerto local tras varios intentos. Vuelve a intentarlo para elegir otro puerto.",
  "Docker has no free network address pools. Remove unused Docker networks or expand Docker’s address pools, then retry.":
    "Docker no tiene grupos de direcciones de red libres. Elimina las redes de Docker que no uses o amplía sus grupos de direcciones y vuelve a intentarlo.",
  "Could not reach the image registry. Check the internet connection, then retry.":
    "No se pudo acceder al registro de imágenes. Revisa la conexión a internet y vuelve a intentarlo.",
  "Docker stopped answering. Start Docker, then retry.":
    "Docker dejó de responder. Inicia Docker y vuelve a intentarlo.",
  "Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin, then retry.":
    "Falta Docker Compose. Instala Docker Desktop o docker-compose-plugin y vuelve a intentarlo.",
  "Downloading Rakazo images failed. Check the output below, then retry.":
    "No se pudieron descargar las imágenes de Rakazo. Revisa la salida de abajo y vuelve a intentarlo.",
  "Rakazo services did not start. Check the output below, then retry.":
    "Los servicios de Rakazo no se iniciaron. Revisa la salida de abajo y vuelve a intentarlo.",
  "The stack started but the web app did not answer. Retry, and check the output below.":
    "El stack se inició, pero la app web no respondió. Vuelve a intentarlo y revisa la salida de abajo.",
  "Could not prepare the local stack. Retry.":
    "No se pudo preparar el stack local. Vuelve a intentarlo.",
  "Could not stop the local stack. Check that Docker is running, then try again.":
    "No se pudo detener el stack local. Comprueba que Docker esté en funcionamiento e inténtalo de nuevo.",
  "Settings…": "Configuración…",
  "New…": "Nuevo…",
  Go: "Ir",
  Back: "Atrás",
  Forward: "Adelante",
  "Next Bot": "Bot siguiente",
  "Previous Bot": "Bot anterior",
  "Command Menu…": "Menú de comandos…",
  "Toggle Sidebar": "Mostrar u ocultar la barra lateral",
  "Search…": "Buscar…",
  "The window closed before the app loaded.": "La ventana se cerró antes de que cargara la app.",
};
