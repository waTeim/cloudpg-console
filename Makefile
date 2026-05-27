# CloudPG Console — Makefile
#
# Convenience wrapper around the npm scripts in package.json.
# `npm` is the only hard dependency; everything else (electron,
# electron-builder, esbuild, react, the k8s + pg clients) installs
# into node_modules.

.PHONY: install build dev start package package-mac package-linux package-win clean distclean

install:
	npm install

# Compile src/*.jsx → out/*.js and stage React/ReactDOM UMD into vendor/.
# The Electron renderer loads CloudPG Console.html which references these.
build: install
	npm run build

dev: build
	npm run dev

start: build
	npm start

# Builds installers for the current platform into ./dist
package: build
	npm run package

package-mac:   build ; npm run package:mac
package-linux: build ; npm run package:linux
package-win:   build ; npm run package:win

clean:
	rm -rf dist out vendor

distclean: clean
	rm -rf node_modules
