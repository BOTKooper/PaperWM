var uuid = "paperwm@hedning:matrix.org";
var Extension = imports.misc.extensionUtils.extensions[uuid];
var Tiling = Extension.imports.tiling;
var Navigator = Extension.imports.navigator;
var Utils = Extension.imports.utils;

var GLib = imports.gi.GLib;
var Signals = imports.signals;
var Gio = imports.gi.Gio;
var Main = imports.ui.main;
var Meta = imports.gi.Meta;
var Misc = imports.misc;
var St = imports.gi.St;

var display = global.display;

var ExtensionSystem = imports.ui.extensionSystem;

var settings = Extension.imports.convenience.getSettings();

var gsettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
var wmsettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
var overrides = new Gio.Settings({schema_id: 'org.gnome.shell.overrides'});

function enable () {
    Main.layoutManager.connect('startup-complete', () => {
        next();
    });
}

function connectOnce(obj, signal, callback) {
    let id = obj.connect(signal, function () {
        obj.disconnect(id);
        callback.apply(window, arguments);
    });
}

function connectOncePromise(obj, signal, timeout=2000) {
    return new Promise(
        (resolve, reject) => {
            let hasTimedOut = false;

            let timeoutId = imports.mainloop.timeout_add(timeout, () => {
                hasTimedOut = true;
                reject(new Error(`TimeoutError ${signal}`));
            });

            function signalHandler(...args) {
                if (hasTimedOut) {
                    log(`Signal arrived after timeout: ${signal}`);
                    return;
                }
                imports.mainloop.source_remove(timeoutId);
                resolve(args);
            }

            connectOnce(obj, signal, signalHandler);
        }
    );
}

/**
 * Converts a function(...args, callback) to its 'async' equivalent 
 */
function asAsync(fnWithCallback) {
    return function(...args) {
        return new Promise((resolve, reject) => {
            fnWithCallback(...args, (...result) => resolve(result))
        });
    }
}

function callAsync(fnWithCallback, ...args) {
    return asAsync(fnWithCallback)(...args);
}

/**
   Run @prog and run callback on space::window-added
 */
function openTiledWindow(prog, callback) {
    connectOnce(display, 'window-created', (display, metaWindow) => {
        let space = Tiling.spaces.spaceOfWindow(metaWindow);
        connectOnce(space, 'window-added', callback);
    });
    Misc.util.spawnApp(prog);
}

function waitPromise(delay) {
    return new Promise(
        (resolve, reject) => imports.mainloop.timeout_add(delay, resolve)
    );
}

function assert(condition, message, ...dump) {
    if (!condition) {
        throw new Error(message + "\n", dump);
    }
}

function visible(metaWindow) {
    let actor = metaWindow.get_compositor_private();
    let clone = metaWindow.clone;
    return actor.visible && !clone.visible;
}

function connect(chain, callback) {
    log(chain.length);
    function connectIter(chain, callback) {
        if (chain.length === 0)
            return callback;
        return () => {
            let [obj, signal] = chain.slice(0, 2);
            connectOnce(obj, signal, connectIter(chain.slice(2), callback));
        };
    }
    assert(chain.length % 2 === 0,
           `connect require an even numbered chain`);
    if (chain.length === 0)
        return callback;

    let [obj, signal] = chain.slice(0, 2);
    connectOnce(obj, signal, connectIter(chain.slice(2), callback));
}

var currentTest = 0;

async function next() {
    try {
        if (currentTest < tests.length) {
            display.get_tab_list(Meta.WindowType.DIALOG, null)
                .forEach(w => {
                    w.delete(global.get_current_time());
                });
            display.get_tab_list(Meta.WindowType.NORMAL, null)
                .forEach(w => {
                    w.delete(global.get_current_time());
                });
            let test = tests[currentTest];
            log(`-- Testing ${test.name}`);
            let result = test();
            if (result && result.constructor === Promise) {
                result
                    .then(next)
                    .catch(Utils.print_stacktrace);
            } 
        }
        currentTest += 1;
    } catch(e) {
        Utils.print_stacktrace(e)
    }
}

var tests = [
    function insertWindow() {
        let signals = new Utils.Signals();
        let windows = 0;
        let space = Tiling.spaces.selectedSpace;
        signals.connect(space, 'window-added', (space, metaWindow) => {
            log(`length: ${space.length}`);
            let first = space[0][0];
            if (space.length === 3) {
                let third = space[2][0];
                connectOnce(third, 'focus', () => {
                    connect([first, 'focus', space, 'move-done'], () => {
                        Misc.util.spawnApp(['xterm']);
                    });
                    Main.activateWindow(first);
                });
            }
            if (space.length < 4)
                return;
            assert(visible(first),
                   `first window not immediately visible`);
            assert(!visible(metaWindow), `insert animation broken`);

            signals.destroy();
            next();
        });
        Misc.util.spawnApp(['xterm']);
        Misc.util.spawnApp(['xterm']);
        Misc.util.spawnApp(['xterm']);
    },
    function fullscreenReactive() {
        openTiledWindow(['tilix'], (space, metaWindow) => {
            assert(metaWindow === space.selectedWindow, `first window isn't selected`);
            let id = metaWindow.connect('notify::fullscreen', (metaWindow) => {
                if (!metaWindow.fullscreen)
                    return;
                metaWindow.disconnect(id);
                connectOnce(space, 'move-done', () => {
                    let actor = metaWindow.get_compositor_private();
                    assert(actor.visible, `Fullscreen window isn't reactive`);
                    assert(!metaWindow.clone.visible, `clone is visible`);
                    next();
                });
            });
            metaWindow.make_fullscreen();
        });
    },
    async function removeWindow() {
        let [space, metaWindow] = await callAsync(openTiledWindow, ['tilix']);

        let windowRemovedPromise = connectOncePromise(space, 'window-removed');
        space.removeWindow(metaWindow);
        await windowRemovedPromise;
        await connectOncePromise(space, 'move-done');

        assert(space.indexOf(metaWindow) === -1, `window wasn't removed`);
        assert(metaWindow.get_compositor_private().visible, `actor isn't visible`);
    },
    function reload() {
        openTiledWindow(['tilix'], (space, metaWindow) => {
            ExtensionSystem.reloadExtension(Extension);
            Extension = imports.misc.extensionUtils.extensions[uuid];
            assert(Extension.state === ExtensionSystem.ExtensionState.ENABLED,
                   `extension didn't reload`);
            // We've build a new space
            assert(Tiling.spaces.selectedSpace !== space, `didn't get a new space`);
            space = Tiling.spaces.selectedSpace;
            assert(space.selectedWindow === metaWindow, `tiled window didn't reattach`);
            next();
        });
    },
    function visibleDialog() {
        let nav = Navigator.getNavigator();
        var Shell = imports.gi.Shell;
        var Tracker = Shell.WindowTracker.get_default();
        openTiledWindow(['tilix'], (space, metaWindow) => {
            connectOnce(display, 'window-created', (display, about) => {
                let actor = about.get_compositor_private();
                connectOnce(actor, 'show', (actor) => {
                    assert(actor.visible && !about.clone.visible, `dialog isn't visible`);
                    nav.finish();
                    next();
                });
            });
            let app = Tracker.get_window_app(metaWindow);
            app.action_group.activate_action('app.about', null);
        });
    },
    function selectSpace() {
        let spaces = Tiling.spaces;
        let oldSpace = spaces.selectedSpace;
        spaces.selectSpace(Meta.MotionDirection.DOWN);
        let space = spaces.selectedSpace;
        assert(space !== oldSpace, `select space din't change space`);
        connectOnce(space, 'move-done', () => {
            let visible = new Map();
            for (let [monitor, space] of spaces.monitors) {
                visible.set(space, true);
            }
            spaces.forEach(s => {
                if (!visible.get(s))
                    assert(!s.actor.visible, `hidden space is visible`);
            });
            next();
        });
        Navigator.getNavigator().finish();
    },
];
