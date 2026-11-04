# Repositorio de ejemplo: text-utils (Fixture de aceptación Fase 3)

Este directorio contiene el proyecto de ejemplo y las definiciones de tareas utilizadas para la prueba de aceptación de la **Fase 3 (Orquestación)** del orquestador casero.

## 1. Qué es

Es un fixture reproducible que simula un repositorio de código real para verificar que el orquestador puede:
1. Tomar un plan de usuario en lenguaje natural y descomponerlo en tareas independientes.
2. Ejecutar las tareas en paralelo en worktrees aislados sin riesgo de colisión de archivos.
3. Integrar las soluciones en una rama común sin conflictos de git.
4. Validar que el gate de calidad (`node --test`) pase tanto al inicio como después de integrar todas las tareas.

El proyecto de ejemplo es una librería de utilidades de texto en **Node 24** (`text-utils`), empaquetada como módulos ES nativos (`.mjs`) **sin dependencias externas** de npm. El gate de verificación es el ejecutor de pruebas nativo de Node: `node --test`.

## 2. Estructura de carpetas

```text
fixtures/repo-ejemplo/
├── plantilla/               # Proyecto base sin dependencias (gate pasa en verde con stubs y todos)
│   ├── package.json
│   ├── src/
│   │   ├── slug.mjs         # Generador de slugs URL
│   │   ├── case.mjs         # Transformaciones camelCase y snake_case
│   │   └── truncate.mjs     # Truncado de cadenas con elipsis
│   └── test/
│       ├── slug.test.mjs    # Pruebas nativas de slug (stubs + todos)
│       ├── case.test.mjs    # Pruebas nativas de case (stubs + todos)
│       └── truncate.test.mjs# Pruebas nativas de truncate (stubs + todos)
├── plan.md                  # Plan en lenguaje natural tal como lo escribe el usuario
├── tareas.json              # Lista de 3 tareas con esquema TaskBrief (ownedPaths disjuntas, dependsOn: [])
├── soluciones/              # Soluciones de referencia para pruebas de integración sin gastar cupo
│   ├── task-slug/           # Modifica únicamente sus ownedPaths (src/slug.mjs, test/slug.test.mjs)
│   ├── task-case/           # Modifica únicamente sus ownedPaths (src/case.mjs, test/case.test.mjs)
│   └── task-truncate/       # Modifica únicamente sus ownedPaths (src/truncate.mjs, test/truncate.test.mjs)
└── README.md                # Este documento explicativo
```

## 3. Tareas y partición de rutas (`ownedPaths`)

Las 3 tareas están diseñadas con dificultad baja (`difficulty: "low"`), sin dependencias mutuas (`dependsOn: []`) y con rutas de propiedad estrictamente disjuntas:

| Tarea ID | Título | Rutas propias (`ownedPaths`) |
|---|---|---|
| `task-slug` | Implementar generador de slugs | `src/slug.mjs`, `test/slug.test.mjs` |
| `task-case` | Conversiones camelCase y snake_case | `src/case.mjs`, `test/case.test.mjs` |
| `task-truncate` | Truncado con elipsis configurable | `src/truncate.mjs`, `test/truncate.test.mjs` |

Ninguna tarea modifica `package.json`, asegurando que no existan conflictos de fusión al unir las tres ramas.

## 4. Cómo crear un repositorio git temporal a partir de la plantilla

### En Linux / WSL:

```bash
# 1. Crear carpeta temporal
REPO_DIR=$(mktemp -d)
echo "Repositorio en: $REPO_DIR"

# 2. Copiar los archivos de la plantilla
cp -r fixtures/repo-ejemplo/plantilla/. "$REPO_DIR"/

# 3. Inicializar git y realizar el commit inicial
cd "$REPO_DIR"
git init
git config user.name "Orquestador Bot"
git config user.email "bot@orquestador.local"
git add .
git commit -m "feat: plantilla inicial de text-utils"

# 4. Comprobar que el gate pasa en verde en la plantilla base
node --test
```

### En Windows (PowerShell):

```powershell
# 1. Crear carpeta temporal
$repoDir = Join-Path $env:TEMP ("repo-ejemplo-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $repoDir -Force

# 2. Copiar archivos de la plantilla
Copy-Item -Path "fixtures\repo-ejemplo\plantilla\*" -Destination $repoDir -Recurse

# 3. Inicializar git y realizar commit inicial
Set-Location $repoDir
git init
git config user.name "Orquestador Bot"
git config user.email "bot@orquestador.local"
git add .
git commit -m "feat: plantilla inicial de text-utils"

# 4. Comprobar el gate
node --test
```

## 5. Cómo probar la integración de soluciones de referencia

Para simular la integración de las 3 tareas sin necesidad de llamar a modelos de IA ni consumir cupo:

```bash
# Copiar las soluciones de referencia sobre el repositorio
cp -r fixtures/repo-ejemplo/soluciones/task-slug/* "$REPO_DIR"/
cp -r fixtures/repo-ejemplo/soluciones/task-case/* "$REPO_DIR"/
cp -r fixtures/repo-ejemplo/soluciones/task-truncate/* "$REPO_DIR"/

# Ejecutar el gate de integración
cd "$REPO_DIR"
node --test
```

El resultado mostrará todas las pruebas aprobadas (9 tests pasados, 0 fallos, 0 pendientes).
