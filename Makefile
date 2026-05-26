# CloudPG Console — Makefile
#
# Convenience wrapper around the npm scripts in package.json.
# `npm` is the only hard dependency; everything else (electron,
# electron-builder, the k8s + pg clients) installs into node_modules.

.PHONY: install dev start package package-mac package-linux package-win clean distclean

install:
	npm install

dev: install
	npm run dev

start: install
	npm start

# Builds installers for the current platform into ./dist
package: install
	npm run package

package-mac:   install ; npm run package:mac
package-linux: install ; npm run package:linux
package-win:   install ; npm run package:win

clean:
	rm -rf dist

distclean: clean
	rm -rf node_modules
