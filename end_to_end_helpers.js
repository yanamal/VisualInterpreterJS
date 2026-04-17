let num_popups = 10;  // make this many pop-ups appear
let popup_delay = 500;  // milliseconds
let max_shift = 300;  // pixels

function make_popup() {
    if (num_popups > 0) {
        num_popups -= 1;

        let top = Math.round(Math.random() * 2 * max_shift - max_shift);
        let left = Math.round(Math.random() * 2 * max_shift - max_shift);
        document.getElementById('popups').insertAdjacentHTML('beforeend',
            `<dialog class="annoying-dialog" style="top:${top}px;left:${left}px" open>Hello this is an annoying pop-up</dialog>`);
        setTimeout(make_popup, popup_delay);
        popup_delay /= 2;
    }
}


// A function to pass to the Interpreter constructor to initialize an Interpreter that is automatically hooked into
// a lot of the external DOM functionality.
// This intentionally breaks the InterpreterJS sandboxing, since we just want the step-by-step interpreting, not the sandboxing.
// It auto-generates wrappers for common DOM classes instead of manually defining each method.
// This particular demo supports Node, Element, NodeList, HTMLCollection, and CSSStyleDeclaration.
function initAutoDomInterpreter(interpreter, globalObject) {
    const nativeCache = new WeakMap();

    // Forward declarations for pseudo classes
    let pseudoNodeClass, pseudoElementClass, pseudoHTMLElementClass,
        pseudoNodeListClass, pseudoHTMLCollectionClass, pseudoCSSStyleDeclarationClass;

    //========================================
    // Core wrapping/unwrapping functions
    //========================================

    function wrapNative(native) {
        if (native == null) return native;
        if (typeof native !== 'object') return native; // primitives pass through

        // Handle collection types
        if (native instanceof NodeList) {
            return wrapArrayLike(native, pseudoNodeListClass, 'nativeNodeList');
        }
        if (native instanceof HTMLCollection) {
            return wrapArrayLike(native, pseudoHTMLCollectionClass, 'nativeCollection');
        }
        if (native instanceof CSSStyleDeclaration) {
            return wrapCSSStyleDeclaration(native);
        }

        // Handle Node/Element
        if (!(native instanceof Node)) {
            // Unknown object type - try to convert as plain object
            return interpreter.nativeToPseudo(native);
        }

        // Check cache for nodes
        if (nativeCache.has(native)) {
            return nativeCache.get(native);
        }

        // Create appropriate pseudo class instance
        let pseudoClass;
        if (native instanceof HTMLElement) {
            pseudoClass = pseudoHTMLElementClass;
        } else if (native instanceof Element) {
            pseudoClass = pseudoElementClass;
        } else {
            pseudoClass = pseudoNodeClass;
        }
        const pseudo = interpreter.createObject(pseudoClass);
        pseudo.nativeNode = native;
        nativeCache.set(native, pseudo);
        return pseudo;
    }

    function wrapArrayLike(nativeList, pseudoClass, nativePropName) {
        const pseudo = interpreter.createObject(pseudoClass);
        pseudo[nativePropName] = nativeList;

        // Set length and indexed properties
        interpreter.setProperty(pseudo, 'length', nativeList.length);
        for (let i = 0; i < nativeList.length; i++) {
            interpreter.setProperty(pseudo, i, wrapNative(nativeList[i]));
        }
        return pseudo;
    }

    function wrapCSSStyleDeclaration(nativeStyle) {
        // CSSStyleDeclaration is special - we create a proxy-like object
        const pseudo = interpreter.createObject(pseudoCSSStyleDeclarationClass);
        pseudo.nativeStyle = nativeStyle;
        return pseudo;
    }

    function unwrap(value) {
        if (value && value.nativeNode) return value.nativeNode;
        if (value && value.nativeNodeList) return value.nativeNodeList;
        if (value && value.nativeCollection) return value.nativeCollection;
        if (value && value.nativeStyle) return value.nativeStyle;
        return value;
    }

    //========================================
    // Auto-wrapper generators
    //========================================

    function createMethodWrapper(methodName) {
        return function (...args) {
            const nativeArgs = args.map(unwrap);
            const result = this.nativeNode[methodName](...nativeArgs);
            return wrapNative(result);
        };
    }

    function createGetterWrapper(propName) {
        return function () {
            return wrapNative(this.nativeNode[propName]);
        };
    }

    function createSetterWrapper(propName) {
        return function (value) {
            this.nativeNode[propName] = unwrap(value);
        };
    }

    // Expose a single property from native class to pseudo prototype
    function exposeProperty(pseudoProto, NativeClass, key) {
        const desc = Object.getOwnPropertyDescriptor(NativeClass.prototype, key);
        if (!desc) {
            console.warn(`Property ${key} not found on ${NativeClass.name}.prototype`);
            return;
        }

        if (typeof desc.value === 'function') {
            interpreter.setProperty(pseudoProto, key,
                interpreter.createNativeFunction(createMethodWrapper(key)));
        } else if (desc.get || desc.set) {
            const propDesc = {};
            if (desc.get) propDesc.get = interpreter.createNativeFunction(createGetterWrapper(key));
            if (desc.set) propDesc.set = interpreter.createNativeFunction(createSetterWrapper(key));
            interpreter.setProperty(pseudoProto, key, Interpreter.VALUE_IN_DESCRIPTOR, propDesc);
        }
    }

    // Expose multiple properties
    function exposeProperties(pseudoProto, NativeClass, keys) {
        for (const key of keys) {
            exposeProperty(pseudoProto, NativeClass, key);
        }
    }

    //========================================
    // Create pseudo classes
    //========================================

    // Node class
    pseudoNodeClass = interpreter.createNativeFunction(function Node() {
        throw TypeError('Illegal constructor');
    }, true);
    interpreter.setProperty(globalObject, 'Node', pseudoNodeClass);
    const pseudoNodeProto = interpreter.getProperty(pseudoNodeClass, 'prototype');

    exposeProperties(pseudoNodeProto, Node, [
        'parentNode', 'childNodes', 'firstChild', 'lastChild',
        'previousSibling', 'nextSibling', 'nodeName', 'nodeType', 'nodeValue',
        'textContent', 'hasChildNodes', 'appendChild', 'removeChild',
        'insertBefore', 'replaceChild', 'cloneNode', 'contains'
    ]);

    // Element class (extends Node)
    pseudoElementClass = interpreter.createNativeFunction(function Element() {
        throw TypeError('Illegal constructor');
    }, true);
    interpreter.setProperty(globalObject, 'Element', pseudoElementClass);
    const pseudoElementProto = interpreter.createObject(pseudoNodeClass);
    interpreter.setProperty(pseudoElementClass, 'prototype', pseudoElementProto);

    exposeProperties(pseudoElementProto, Element, [
        'innerHTML', 'outerHTML', 'id', 'className',
        'tagName', 'getAttribute', 'setAttribute', 'removeAttribute',
        'hasAttribute', 'getElementsByClassName', 'getElementsByTagName',
        'querySelector', 'querySelectorAll', 'remove', 'children',
        'firstElementChild', 'lastElementChild',
        'nextElementSibling', 'previousElementSibling'
    ]);

    // HTMLElement class (extends Element) - has 'style' property
    pseudoHTMLElementClass = interpreter.createNativeFunction(function HTMLElement() {
        throw TypeError('Illegal constructor');
    }, true);
    interpreter.setProperty(globalObject, 'HTMLElement', pseudoHTMLElementClass);
    const pseudoHTMLElementProto = interpreter.createObject(pseudoElementClass);
    interpreter.setProperty(pseudoHTMLElementClass, 'prototype', pseudoHTMLElementProto);

    exposeProperties(pseudoHTMLElementProto, HTMLElement, [
        'style', 'hidden', 'title', 'lang', 'dir',
        'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent',
        'click', 'focus', 'blur'
    ]);

    // NodeList class
    pseudoNodeListClass = interpreter.createNativeFunction(function NodeList() {
        throw TypeError('Illegal constructor');
    }, true);
    interpreter.setProperty(globalObject, 'NodeList', pseudoNodeListClass);
    const pseudoNodeListProto = interpreter.getProperty(pseudoNodeListClass, 'prototype');

    // NodeList.item() method
    interpreter.setProperty(pseudoNodeListProto, 'item',
        interpreter.createNativeFunction(function (index) {
            return wrapNative(this.nativeNodeList.item(index));
        }));

    // HTMLCollection class
    pseudoHTMLCollectionClass = interpreter.createNativeFunction(function HTMLCollection() {
        throw TypeError('Illegal constructor');
    }, true);
    interpreter.setProperty(globalObject, 'HTMLCollection', pseudoHTMLCollectionClass);
    const pseudoHTMLCollectionProto = interpreter.getProperty(pseudoHTMLCollectionClass, 'prototype');

    interpreter.setProperty(pseudoHTMLCollectionProto, 'item',
        interpreter.createNativeFunction(function (index) {
            return wrapNative(this.nativeCollection.item(index));
        }));

    // CSSStyleDeclaration class
    pseudoCSSStyleDeclarationClass = interpreter.createNativeFunction(function CSSStyleDeclaration() {
        throw TypeError('Illegal constructor');
    }, true);
    interpreter.setProperty(globalObject, 'CSSStyleDeclaration', pseudoCSSStyleDeclarationClass);
    const pseudoCSSStyleProto = interpreter.getProperty(pseudoCSSStyleDeclarationClass, 'prototype');

    // For CSSStyleDeclaration, we expose common style properties dynamically
    const commonStyleProps = [
        'display', 'visibility', 'opacity', 'color', 'backgroundColor',
        'width', 'height', 'margin', 'padding', 'border',
        'position', 'top', 'left', 'right', 'bottom',
        'fontSize', 'fontWeight', 'fontFamily', 'textAlign',
        'transform', 'transition', 'zIndex', 'overflow'
    ];

    for (const prop of commonStyleProps) {
        const getter = interpreter.createNativeFunction(function () {
            return this.nativeStyle[prop];
        });
        const setter = interpreter.createNativeFunction(function (value) {
            this.nativeStyle[prop] = value;
        });
        interpreter.setProperty(pseudoCSSStyleProto, prop, Interpreter.VALUE_IN_DESCRIPTOR,
            {get: getter, set: setter});
    }

    // Also expose setProperty/getPropertyValue for arbitrary CSS properties
    interpreter.setProperty(pseudoCSSStyleProto, 'setProperty',
        interpreter.createNativeFunction(function (prop, value, priority) {
            this.nativeStyle.setProperty(prop, value, priority || '');
        }));

    interpreter.setProperty(pseudoCSSStyleProto, 'getPropertyValue',
        interpreter.createNativeFunction(function (prop) {
            return this.nativeStyle.getPropertyValue(prop);
        }));

    //========================================
    // Global document object
    //========================================

    const pseudoDocument = interpreter.nativeToPseudo({});
    interpreter.setProperty(globalObject, 'document', pseudoDocument);

    const documentMethods = [
        'getElementById', 'getElementsByClassName', 'getElementsByTagName',
        'querySelector', 'querySelectorAll', 'createElement', 'createTextNode'
    ];

    for (const method of documentMethods) {
        interpreter.setProperty(pseudoDocument, method,
            interpreter.createNativeFunction(function (...args) {
                return wrapNative(document[method](...args));
            }));
    }

    // document.body and document.documentElement
    interpreter.setProperty(pseudoDocument, 'body', Interpreter.VALUE_IN_DESCRIPTOR, {
        get: interpreter.createNativeFunction(function () {
            return wrapNative(document.body);
        })
    });

    interpreter.setProperty(pseudoDocument, 'documentElement', Interpreter.VALUE_IN_DESCRIPTOR, {
        get: interpreter.createNativeFunction(function () {
            return wrapNative(document.documentElement);
        })
    });

    //========================================
    // Utilities: alert, console
    //========================================

    interpreter.setProperty(globalObject, 'alert',
        interpreter.createNativeFunction(function (text) {
            return window.alert(arguments.length ? text : '');
        }));

    const pseudoConsole = interpreter.nativeToPseudo({});
    interpreter.setProperty(globalObject, 'console', pseudoConsole);
    interpreter.setProperty(pseudoConsole, 'log',
        interpreter.createNativeFunction(function (...args) {
            console.log('[Interpreter]', ...args);
        }));
}


