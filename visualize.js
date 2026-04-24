/**
 * Generate a UUID v4
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        let r = Math.random() * 16 | 0;
        let v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Add UUIDs to all nodes in the AST recursively
 */
function addUUIDsToAST(node) {
    if (!node || typeof node !== 'object') {
        return;
    }

    // Add UUID to this node if it has a type (is an AST node)
    if (node.type) {
        node.uuid = generateUUID();
    }

    // Recursively process all properties
    for (let key in node) {
        if (node.hasOwnProperty(key) && key !== 'uuid') {
            let value = node[key];
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    addUUIDsToAST(value[i]);
                }
            } else if (value && typeof value === 'object') {
                addUUIDsToAST(value);
            }
        }
    }
}

/**
 * Wrap piece of code text into spans (also escape any HTML characters that may be present in the code itself, so they render correctly)
 */
function wrapCodeChunk(str) {
    str = str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    let pieces = []
    for (let p of str.split('\n')) {
        pieces.push(`<span class="code-text">${p}</span>`)
    }

    return pieces.join('\n')
}

/**
 * Recursive function to collect flat list of required span open/close tags from AST nodes
 */
function collectTags(node, tags, depth=0, keyInParent=null) {
    if (!node || typeof node !== 'object') {
        return;
    }

    // If this is an AST node (has type, start, end), collect data for open/close tags
    // TODO: ensure start < end? (non-empty length) - otherwise logic of "closes before opens" fails for nodes of length 0
    if (node.type && typeof node.start === 'number' && typeof node.end === 'number') {
        tags.push({
            pos: node.start,
            type: 'open',
            nodeType: node.type,
            keyInParent: keyInParent,
            uuid: node.uuid,
            end: node.end,
            length: node.end - node.start,
            depth: depth
        });
        tags.push({
            pos: node.end,
            type: 'close',
            nodeType: node.type,
            keyInParent: keyInParent,
            uuid: node.uuid,
            start: node.start,
            length: node.end - node.start,
            depth: depth
        });
    }

    // Recurse as necessary
    for (let key in node) {
        if (node.hasOwnProperty(key) && key !== 'uuid' && key !== 'type' && key !== 'start' && key !== 'end') {
            let value = node[key];
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    collectTags(value[i], tags, depth+1, key);
                }
            } else if (value && typeof value === 'object') {
                collectTags(value, tags, depth+1, key);
            }
        }
    }
}

/**
 * Build nested HTML spans from the AST
 */
function buildNestedHTML(code, ast, errorInfo = null) {
    let tags = [];
    collectTags(ast, tags)

    // Add error marker tag if there's an error
    if (errorInfo && typeof errorInfo.pos === 'number') {
        tags.push({
            pos: errorInfo.pos,
            type: 'error',
            message: errorInfo.message || 'Syntax error'
        });
    }

    // Sort tags:
    // - By position
    // - At same position: closes before opens (to properly nest)
    // - Error markers come after closes but before opens at the same position
    // - For opens at same position: longer spans first (parents before children)
    // - For closes at same position: shorter spans first (children close before parents - not strictly necessary when everything is spans, but might as well)
    tags.sort(function (a, b) {
        if (a.pos !== b.pos) {
            return a.pos - b.pos;
        }
        // At same position - define type priority: close=0, error=1, open=2
        function typePriority(tag) {
            if (tag.type === 'close') return 0;
            if (tag.type === 'error') return 1;
            return 2; // open
        }

        let aPriority = typePriority(a);
        let bPriority = typePriority(b);

        if (aPriority !== bPriority) {
            return aPriority - bPriority;
        }

        // Same type at same position
        if (a.type === 'open') {
            // Longer (parent) spans open first
            return b.length - a.length;
        } else if (a.type === 'close') {
            // Shorter (child) spans close first
            return a.length - b.length;
        }
        // For error type, order doesn't matter (there should only be one)
        return 0;
    });

    // Build the HTML string with wrapper
    let result = ['<span class="code-wrapper">'];
    let lastPos = 0; // last position of code text that we've already processed/added to the HTML string

    for (let j = 0; j < tags.length; j++) {
        let tag = tags[j];

        // Add any text between last position and this tag
        if (tag.pos > lastPos) {
            result.push(wrapCodeChunk(code.substring(lastPos, tag.pos)));
            lastPos = tag.pos;
        }

        if (tag.type === 'open') {
            result.push(
                `<span data-uuid="${tag.uuid}" data-node-type="${tag.nodeType}" data-key-in-parent="${tag.keyInParent}" class="ast-node ast-${tag.nodeType.toLowerCase()}" data-depth="${tag.depth}">`
            );
        } else if (tag.type === 'close') {
            result.push('</span>');
        } else if (tag.type === 'error') {
            // Insert empty error marker span with escaped message
            let escapedMessage = tag.message
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
            result.push(
                `<span class="parse-error-marker" data-error-message="${escapedMessage}"></span>`
            );
        }
    }

    // Add any remaining text
    if (lastPos < code.length) {
        result.push(wrapCodeChunk(code.substring(lastPos)));
    }

    result.push('</span>'); // close wrapper

    return result.join('');
}

// TODO: option to add class (e.g. "unparsed") to html nodes?..
function parseIntoHTML(code) {
    try {
        // Parse the code using acorn (ES5)
        let ast = acorn.parse(code, {
            ecmaVersion: 5,
            locations: true
        });

        // Add UUIDs to all nodes
        addUUIDsToAST(ast);

        // Generate the nested HTML
        let html = buildNestedHTML(code, ast);
        return {
            ast: ast,
            html: html,
            parse_success: true,
            error: null
        }
    } catch (e) {
        console.log(e.pos) // the position (index in the string) of the parsing error
        console.log(e.message) // The error message

        let ast = acorn.loose.parse(code, {
            ecmaVersion: 5,
            locations: true
        });

        // Add UUIDs to all nodes in the partial AST
        addUUIDsToAST(ast);

        // Generate HTML with error marker
        let errorInfo = {
            pos: e.pos,
            message: e.message
        };
        let html = buildNestedHTML(code, ast, errorInfo);

        return {
            ast: ast,
            html: html,
            parse_success: false,
            error: errorInfo
        }
    }
}

// Play an animation for 'activating' a specific AST node within a marked-up piece of code.
// if activate is false, play the animation backwards (i.e. deactivating).
function animateNode(nodeEl, duration=300, activate=true, activeClass='parsing') {
    const animation = new Animation(
        new KeyframeEffect(nodeEl, [
            { top: '0px', left: '0px', zIndex: '0'},
            { top: `-3px`, left: `7px`, zIndex: '1'}  // translate diagonally to give the illusion of raising up; also increase z-index to be above sibling nodes (that are not active/animated)
        ], {
            duration: duration,
            easing: 'linear',
            fill: 'both'
        })
    );

    if(activate) {
        nodeEl.classList.add(activeClass);
    }
    else {
        animation.reverse();
        animation.finished.then(function() {
            nodeEl.classList.remove(activeClass); // remove class *after* node animation has reversed
        })
    }

    animation.play();
    return animation.finished; // return the animation's promise which is resolved when the animation completes.
}

/**
 * Position (or reposition) a tooltip relative to its target element within a wrapper.
 * @param {Element} tooltip - The tooltip element
 * @param {Element} targetElement - The element to position the tooltip relative to
 * @param {Element} wrapper - The code wrapper element containing both
 */
function positionTooltip(tooltip, targetElement, wrapper) {
    const targetRect = targetElement.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();

    // Calculate center X of target relative to wrapper
    // CSS transform: translateX(-50%) will center the tooltip on this point
    const targetCenterX = targetRect.left - wrapperRect.left + targetRect.width / 2;
    const targetTop = targetRect.top - wrapperRect.top;

    // Measure tooltip height for vertical positioning
    const tooltipHeight = tooltip.offsetHeight;

    // Position above the target
    const top = targetTop - tooltipHeight - 2;

    tooltip.style.left = targetCenterX + 'px';
    tooltip.style.top = top + 'px';
}


/**
 * Continuously reposition a tooltip to follow its target element during animation.
 * Uses requestAnimationFrame and stops when the animation promise resolves
 * or the tooltip is removed from the DOM.
 * @param {Element} tooltip - The tooltip element
 * @param {Element} targetElement - The animated element the tooltip follows
 * @param {Element} wrapper - The code wrapper element
 * @param {Promise} animationFinished - Promise that resolves when the animation completes
 */
function trackTooltipToNode(tooltip, targetElement, wrapper, animationFinished) {
    let tracking = true;

    animationFinished.finally(() => { tracking = false; });

    function update() {
        if (!tracking || !tooltip.isConnected) return;
        positionTooltip(tooltip, targetElement, wrapper);
        requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

// TODO: consider using popover API  for tooltips?..
/**
 * Shows a tooltip positioned relative to a target element within a code wrapper
 * @param {Element} targetElement - The element to position the tooltip relative to
 * @param {Element} wrapper - The code wrapper element to insert the tooltip into
 * @param {string} message - The message to display in the tooltip
 * @param {string} type - The tooltip type: 'parse-error', 'value', or 'runtime-error'
 * @returns {Element} The created tooltip element
 */
function showCodeTooltip(targetElement, wrapper, message, type) {
    // Remove any existing tooltip from the wrapper
    removeCodeTooltip(wrapper);

    // Create tooltip element
    const tooltip = document.createElement('div');
    tooltip.className = `code-tooltip code-tooltip-${type}`;
    tooltip.innerHTML = `
        <div class="code-tooltip-content">${message}</div>
        <div class="code-tooltip-arrow"></div>
    `;

    // Insert tooltip into wrapper
    wrapper.appendChild(tooltip);

    // Position the tooltip relative to wrapper
    positionTooltip(tooltip, targetElement, wrapper);

    return tooltip;
}

/**
 * Remove any code tooltip from a wrapper element
 * @param {Element} wrapper - The wrapper element to remove tooltips from
 */
function removeCodeTooltip(wrapper) {
    // TODO: remove all, just in case?.. there should only ever be one
    const existingTooltip = wrapper.querySelector('.code-tooltip');
    if (existingTooltip) {
        existingTooltip.remove();
    }
}

/**
 * Show parse-error tooltip positioned relative to the error marker
 * Tooltip is inserted as a sibling within the code wrapper
 */
function showParseErrorTooltip(errorMarker) {
    const message = errorMarker.getAttribute('data-error-message');

    // Highlight the error marker
    errorMarker.classList.add('error-active');

    // Find the code wrapper to insert tooltip into
    let wrapper = errorMarker.closest('.code-wrapper');
    if (!wrapper) {
        console.error('Could not find code wrapper for error tooltip');
        return null;
    }

    return showCodeTooltip(errorMarker, wrapper, message, 'parse-error');
}

// Animate the parsing process for the HTML generated by parseIntoHTML.
// Assumes codeElem is the top-level .code-wrapper element generated by parseIntoHTML (rather than, for example, some other wrapper on top of it).
function animateParse(codeElem, aTime=150, siblingGap=50) {
    // Add "unparsed" class so that the nodes don't already have the "parsed ast node" css at the start of the parsing animation.
    codeElem.querySelectorAll('.ast-node').forEach(function (n){
        n.classList.add('unparsed')
    })

    // Find error marker and its containing AST node (if any) upfront
    const errorMarker = codeElem.querySelector('.parse-error-marker');
    let errorContainingNode = null;

    if (errorMarker) {
        // Find the closest parent AST node that directly contains this error marker
        let parent = errorMarker.parentNode;
        while (parent && parent !== codeElem) {
            if (parent.classList && parent.classList.contains('ast-node')) {
                errorContainingNode = parent;
                break;
            }
            parent = parent.parentNode;
        }
    }

    // First, recursively activate all nodes and collect them
    const allNodes = [];
    let errorEncountered = false;
    let errorTooltip = null;

    function activateRecursively(node, delay = 0) {
        return new Promise(function(resolve, reject) {
            // If error was already encountered, don't start new animations
            if (errorEncountered) {
                resolve({ stopped: true });
                return;
            }

            setTimeout(function() {
                // Check again after delay
                if (errorEncountered) {
                    resolve({ stopped: true });
                    return;
                }

                // Check if this node is the one that directly contains the error
                if (node === errorContainingNode) {
                    // Found the node that contains the error
                    errorEncountered = true;

                    // Highlight the node that contains the error
                    node.classList.add('error-node');

                    // Show the error tooltip
                    errorTooltip = showParseErrorTooltip(errorMarker);

                    resolve({ stopped: true, errorNode: node });
                    return;
                }

                allNodes.push(node);
                animateNode(node, aTime, true).then(function() {
                    // Check for error after animation completes
                    if (errorEncountered) {
                        resolve({ stopped: true });
                        return;
                    }

                    const children = [...node.querySelectorAll(':scope>.ast-node')];

                    // Stagger children by siblingGap
                    Promise.all(children.map(function(childNode, index) {
                        return activateRecursively(childNode, index * siblingGap);
                    })).then(function(results) {
                        // Check if any child encountered an error
                        const errorResult = results.find(r => r && r.stopped);
                        resolve(errorResult || { stopped: false });
                    });
                });
            }, delay);
        });
    }

    // Activate all nodes, then deactivate all at once (unless error encountered)
    return activateRecursively(codeElem).then(function(result) {
        if (result && result.stopped) {
            // Error was encountered - don't deactivate, leave in current state
            // The nodes that were activated stay activated (parsing state).
            return {
                errorEncountered: true,
                error: {
                    message: errorMarker ? errorMarker.getAttribute('data-error-message') : null,
                    marker: errorMarker,
                    node: errorContainingNode,
                    tooltip: errorTooltip
                }
            };
        }

        // All nodes are now activated; deactivate them all simultaneously
        return Promise.all(allNodes.map(function(node) {
            // animate "deactivating" the nodes all at once
            return animateNode(node, aTime, false).then(function(){
                // Remove "unparsed" class: the nodes should actually look parsed now.
                codeElem.querySelectorAll('.ast-node').forEach(function (n){
                    n.classList.remove('unparsed')
                })
            });
        })).then(function() {
            return {
                errorEncountered: false,
                error: null
            };
        });
    });
}

// Replace element(which presumably contains editable code) with the parsed version of the code and animate the parsing visualization
// Original element is just made transparent, not removed.
// Returns "reset" function to put things back to the way they were before the "replace" operation.
function replace_with_parsed(elem, code) {
    const parsed = parseIntoHTML(code);
    const parsed_elem = document.createElement('pre');
    parsed_elem.innerHTML = parsed.html;

    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';

    // Capture original inline styles before modifying
    const originalStyles = {
        position: elem.style.position,
        top: elem.style.top,
        left: elem.style.left,
        margin: elem.style.margin,
        width: elem.style.width,
        height: elem.style.height,
        display: elem.style.display
    };

    elem.parentNode.insertBefore(wrapper, elem);

    // Do a "card flip" rotation (halfway, to be invisible) out using Web Animations API
    const rotateOut = elem.animate(
        [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(90deg)' }],
        {
            duration: 500,
            easing: 'ease-out',
            fill: 'forwards'
        }
    );

    // When rotating out completes, flip parsed element in, then animate the parsing
    let rotateIn = null;  // set once flip-in starts, so reset() can cancel it
    let anim_promise = rotateOut.finished.then(() => {
        elem.style.display = 'none';
        wrapper.appendChild(parsed_elem);

        rotateIn = parsed_elem.animate(
            [{ transform: 'rotateX(90deg)' }, { transform: 'rotateX(0deg)' }],
            { duration: 500, easing: 'ease-in', fill: 'forwards' }
        );

        return rotateIn.finished.then(() => {
            const codeWrapper = parsed_elem.querySelector('.code-wrapper');
            if (codeWrapper) {
                return animateParse(codeWrapper);
            }
        });
    });

    // Return data about the parsed code and associated visible elements/animations.
    return {
        anim_promise: anim_promise,
        parsed_data: parsed,
        codeElem: parsed_elem.querySelector('.code-wrapper'), // TODO: redundant with codeWrapper variable above
        reset: function () {  // reset function - encapsulates all cleanup knowledge
            rotateOut.cancel();
            if (rotateIn) rotateIn.cancel();

            // Restore original inline styles
            Object.assign(elem.style, originalStyles);

            // Remove wrapper with parsed code element
            wrapper.remove();
        }
    }
}

// interpret the previously parsed code associated with codeElem and codeAst
// If anim_time is > 0, animate the interpreting process as the interpreter runs.
// optionally provide an init function for the interpeter (e.g. special set-up for the environment that the code being interpreted can interact with)
async function interpretCode(codeElem, codeAst, anim_time=300, accelerate=false, interpreterInitFunc=null){
    let interpreter = new window.Interpreter(codeAst, interpreterInitFunc);
    let executionTrace = [];

    // Run code step-by-step using stepAndTrace, collect sequence of step traces
    let continueExecution = true;
    while(continueExecution) {
        let stepResult = await stepAndTrace(interpreter, codeElem, anim_time);
        executionTrace.push(stepResult);

        // Check if the last step was actually executed
        continueExecution = stepResult.step_executed && !stepResult.exception;
        if(accelerate && anim_time > 1) {
            anim_time = Math.max(anim_time-1, 1)
        }
    }

    // Deactivate all nodes when interpreting animation is complete
    if(anim_time > 0 && codeElem) {
        const allNodes = codeElem.querySelectorAll('.ast-node.interpreting');
        const deactivationPromises = [];
        for(let node of allNodes) {
            node.classList.remove('top');
            deactivationPromises.push(animateNode(node, anim_time, false, 'interpreting'));
        }
        await Promise.all(deactivationPromises);
        // Remove any tooltips at the end
        removeCodeTooltip(codeElem);
    }

    // return:
    // - resulting execution trace
    // - interpreter object
    return {
        executionTrace: executionTrace,
        interpreter: interpreter
    };
}

// Statement types that don't produce meaningful values
const NON_VALUE_PRODUCING_TYPES = new Set([
    'BlockStatement',
    'BreakStatement',
    'ContinueStatement',
    'DebuggerStatement',
    'DoWhileStatement',
    'EmptyStatement',
    'ExpressionStatement',
    'ForStatement',
    'ForInStatement',
    'FunctionDeclaration',
    'IfStatement',
    'LabeledStatement',
    'Program',
    'ReturnStatement',
    'SwitchStatement',
    'SwitchCase',
    'ThrowStatement',
    'TryStatement',
    'CatchClause',
    'VariableDeclaration',
    'WhileStatement',
    'WithStatement'
]);

// Map of certain "special" node types where the produced value should sometimes, but not always, be suppressed
suppressProducedValue = {
    'Identifier': (state) => state.components  //This is an Identifier of a thing which is being "retrieved" from the scope for modification (see also below in stepHasSideEffect)
}

// Map of certain "special" node types to function which returns true if we expect the current step
// (as defined by the state object at the top of the state stack) to produce side effects when it is evaluated
// (e.g. initializing a variable, changing the value of a variable)
stepHasSideEffect = {
    'VariableDeclaration': (state) => state.init_,  // when the state for a VariableDeclaration has an init_ value, it's about to actually initialize that variable
    'AssignmentExpression': (state) => (state.doneRight_ && state.doneLeft_),  // when the state for an AssignmentExpression has already marked both doneRight_ and doneLeft_, it is about to actuall perform the assignment.
    'Identifier': (state) => state.components  // when the state is an Identifier expression and components is true in that state, this is actually getting the variable from the scope (to modify, e.g. by assigning a value)
    // TODO: this Identifier logic also triggers when we run a function, which is not technically a side effect (distinguish?)
    //  although actually, technically, in both cases we are just *getting* a thing, but not yet changing it? so is it a side effect either way? (probably, and probably the Interpreter object case is the same)
    // TODO: UpdateExpression has side effect?..
}

function getCloneOrDesc(value){
    if(value instanceof window.Interpreter.Object) return null
    if(Array.isArray(value) && value[0] instanceof window.Interpreter.Object) return null
    try {
        return structuredClone(value);
    }
    catch (error) {
        return value.toString();
    }
}

// stepAndTrace runs exactly one step in the current interpreter, collect trace data, and animate the corresponding codeElem if animate is set to true.
// The underlying interpreter (JS-interpreter) works in the following way:
// At any time, there is a "state stack" corresponding to the nodes in the AST that are in the process of being evaluated.
// Each node reprsented in this stack is at **some** stage in its own evaluation process, which is tracked by the corresponding state in the state stack.
// At each step, the interpreter takes the top-level state in the state stack,
//   and processes the next step in that particular node/state's evaluation process (based on the node type and its current state).
// This processing (always? almost always?) does **one** of two things:
// (1) Creates a new state on top of the state stack, corresponding to one of the **child nodes** of the currently-evaluated node,
//     which needs to be processed before the current node can finish evaluating.
//     (e.g. evaluating the condition inside the if statement before being able to decide whether to evaluate the body of the if)
// (2) Fully completes evaluating the current node and pops it off the stack;
//     The evaluation typically results in a value, and that value is then assigned to the state.value field of the **current** top-level state of the state stack,
//     which is (always? almost always?) the state that triggered the evalation of this node in the first place.
//     (e.g fully evaluating a conditional expression, and then setting the state.value of whatever node triggered that conditional expression to the final true/false value)
// Based on this interpreter process, the two critical components for visualizing/representing what happened in a particular step are:
// (1) The stateStack **before** the step happened: this state stack captures which node is about to be partially or completely evaluated in this step
//     (the node that's in the top state of the state stack), as well as all the underlying nodes that are partway through evaluation (the rest of the stack)
// (2) The state.value of the top state **after** the step happened: the result of the current step's evaluation is stored in state.value
// Other information is also captured by stepAndTrace, but the visualization specifically represents the stack **before** and the evaluated value **after**.
// This is a little wonky, and there's at least one edge case, but it seems like the least-bad and most clear way of representing what happened in a given step.

// Edge case: when a state is popped off a stateStack, but it does *not* set or change the value of the parent node/state,
//  then the observed value in the top of the post-evaluation state stack is whatever value that parent state had previously, for whatever reason.
//  for example: a ForStatement evaluates to true each time it decides that it still needs to go through another iteration of the loop;
//  it then processes and executes its entire associated BlockStatement;
//  the BlockStatement does not return anything when it pops itself off the state stack, but the ForStatement still has the value true from before.
//  So this looks fairly indistinguishable (under the current scheme) from the BlockStatement returning true for some reason.
//  On the other hand, there value **could** be set to the same thing legitimately, e.g. if evaluating 2+2,
//  both literals evaluate to 2 and set the parent node's value to 2 at both stages.
// We deal with this edge case by suppressing the value if the node that was just evaluated (e.g. BlockStatement) is not a type of node that's expected to produce a value.
// Hopefully there aren't any exciting node types that only **sometimes** produce a value.
function stepAndTrace(interpreter, codeElem=null, anim_time=300){
    // Capture the state BEFORE the step executes
    const preStepStack = interpreter.stateStack.map(state => ({
        uuid: state.node.uuid,
        nodeType: state.node.type,
        value: getCloneOrDesc(state.value)
    }));

    let activeNode = null;  // The node being processed in this step (top of stack before the step is evaluated)
    let hasSideEffect = false;  // Is this step expected to have a side effect (e.g. initializing/changing variable)?
    let shouldSuppressValue = false;  // should we suppress any produced values, even if the node type is not one of those where we should *always* suppress it?
    // I'm pretty sure that the if below is always true (at the very least, the Program node is in the stack for as long as there is anything else left to do), but just in case
    if(preStepStack.length > 0)
    {
        activeNode = preStepStack[preStepStack.length - 1]
        hasSideEffect = (activeNode.nodeType in stepHasSideEffect) && stepHasSideEffect[activeNode.nodeType](interpreter.stateStack[interpreter.stateStack.length-1])
        shouldSuppressValue = (activeNode.nodeType in suppressProducedValue) && suppressProducedValue[activeNode.nodeType](interpreter.stateStack[interpreter.stateStack.length-1])
    }

    // Execute the step
    let step_executed;
    let exception = null;
    try {
        step_executed = interpreter.step(); // Returns whether the step was successfully executed by the interpreter
        //TODO: if step is paused (waiting for async function to complete), and the step had to wait for it/do nothing, then step_executed is true, but nothing happens.
    } catch(e) {
        exception = {
            message: e.message || e.toString(),
            stack: e.stack
        };
        step_executed = false; // Mark as not executed when exception occurs
    }

    // Capture the state AFTER the step executes
    const postStepStack = interpreter.stateStack.map(state => ({
        uuid: state.node.uuid,
        nodeType: state.node.type,
        value: getCloneOrDesc(state.value)
    }));

    // Analyze what happened during this step
    let pushedNode = null;     // Info about the node that was pushed, if any
    let completedNode = null;  // Info about the node that completed (was popped), if any
    let producedValue = undefined;  // Value produced by the completed node

    if (step_executed && activeNode) {
        const preLen = preStepStack.length;
        const postLen = postStepStack.length;

        if(preLen > postLen) {
            // The stateStack got shorter; we assume that this means the top node was completed and popped off the stack.
            completedNode = activeNode;

            // Capture producedValue IF this node type actually produces values.
            // Otherwise, this may be a spurious "produced" value that's actually an intermediate value from an earlier calculation
            // (See also edge case description in lengthy comment above the function)
            if (!NON_VALUE_PRODUCING_TYPES.has(activeNode.nodeType) && !shouldSuppressValue && postLen > 0) {
                // postLen should also always be > 0 if step_executed was true, but again, checking just in case
                producedValue = postStepStack[postLen - 1].value;
            }
        }
        else {
            // The stateStack did **not** get shorter; we assume that this is the other possibility, where a new state was pushed onto the state stack.
            // TODO: the last and second-to-last step (when program finishes) breaks this assumption. Both the pre- and post- stack are just the Program node
            //  (step_executed is also false in the last step, so actually the last step never even enters this if/else;
            //   however, the second-to-last step typically looks very similar - both stacks are just the Program - and *does* evaluate to true, so is recorded as "pushed node")
            // Record the node that was presumably pushed onto the state stack
            pushedNode = {
                uuid: postStepStack[postLen - 1].uuid,
                nodeType: postStepStack[postLen - 1].nodeType
            };
        }
    }

    // record data about what happened during this step.
    // some values are currently unused (e.g. pushedNode, postStepStack), but may be useful later, who knows.
    const result = {
        activeNode: activeNode,
        hasSideEffect: hasSideEffect,
        completedNode: completedNode,
        producedValue: producedValue,
        pushedNode: pushedNode,
        preStepStack: preStepStack,
        postStepStack: postStepStack,
        step_executed: step_executed,
        exception: exception
    };

    //console.log(result);

    if(anim_time > 0) {
        return animateInterpreterState(result, codeElem, anim_time);
    }
    else{
        return Promise.resolve(result);
    }
}

function getTraceStepFilter(
    include_produced_value=true, // this step completed evaluating a node AND the evaluation returned a value
    include_completed_node=true, // this step completed evaluating a node (regardless of whether the evaluation produced an explicit return value)
    include_side_effects=true, // this step did something that's considered a "side effect", e.g. changing the value of a variable
    include_pushed_node=false, // this step was a partial evaluation of a "parent" node that ended with pushing a child node onto the state stack
    exclude_types=['ExpressionStatement', 'BlockStatement']
    ) {
    // Note: the order of these return checks depends somewhat on how the different possible types of states relate to each other, and what seems to make sense to include/exclude
    // It's probably fine.
    return function(stepResult){
        if(exclude_types.includes(stepResult.activeNode.nodeType)) {
            return false;
        }
        if(include_completed_node && stepResult.completedNode) {
            return true;
        }
        if(include_produced_value && stepResult.producedValue) {
            return true;
        }
        if(include_side_effects && stepResult.hasSideEffect) {
            return true;
        }
        if(include_pushed_node && stepResult.pushedNode) {
            return true;
        }
        return false;
    }
}

// Animate a change in the visualization inside codeElem from the current active interpreter state (if any) to the one described in stepResult
// TODO: try to figure out a way to adjust tooltip position as node moves (or at least after it moves); but ideally still show tooltip even at the beginning?
function animateInterpreterState(stepResult, codeElem, duration=300){
    console.log(stepResult)
    const { activeNode, producedValue, preStepStack, exception } = stepResult;

    // See comments before stepAndTrace for why we are using preStepStack coupled with producedValue to represent what happened in a particular step
    const newActiveUUIDs = new Set(preStepStack.map(state => state.uuid));

    // The top node is the activeNode (top of preStepStack when the step began)
    const topUUID = activeNode ? activeNode.uuid : null;

    const animationPromises = [];

    // Remove any tooltips from previous steps first
    removeCodeTooltip(codeElem);

    // Get all ast-node spans in codeElem
    const allNodes = codeElem.querySelectorAll('.ast-node');

    for(let nodeEl of allNodes) {
        const uuid = nodeEl.dataset.uuid;
        const wasActive = nodeEl.classList.contains('interpreting');
        const shouldBeActive = newActiveUUIDs.has(uuid);
        const shouldBeTop = uuid === topUUID;

        let nodeAnimationPromise = null;

        // Handle activation/deactivation
        if(shouldBeActive && !wasActive) {
            // Activate this node
            nodeAnimationPromise = animateNode(nodeEl, duration, true, 'interpreting');
            animationPromises.push(nodeAnimationPromise);
        } else if(!shouldBeActive && wasActive) {
            // Deactivate this node
            //nodeEl.classList.remove('top'); // TODO: is this necessary or will it always be handled by logic below?
            animationPromises.push(animateNode(nodeEl, duration, false, 'interpreting'));
        }

        // Handle 'top' class separately (can change even if activation state doesn't)
        if(shouldBeTop) {
            nodeEl.classList.add('top');

            if(stepResult.hasSideEffect){
                nodeEl.classList.add('side-effect');
            }
            if(stepResult.producedValue !== null && stepResult.producedValue !== undefined) {
                nodeEl.classList.add('has-value');
            }

            // Show tooltip for the top node (unless animating too fast for it to be relevant)
            if(duration > 200) {
                let tooltip = null;
                if (exception) {
                    tooltip = showCodeTooltip(nodeEl, codeElem, exception.message, 'runtime-error');
                } else if (producedValue !== undefined && producedValue !== null) {
                    // Format the value for display
                    let formattedValue = formatInterpreterValue(producedValue);
                    tooltip = showCodeTooltip(nodeEl, codeElem, formattedValue, 'value');
                }

                // If we have a tooltip and the node is being activated (animating),
                // track its position throughout the animation
                if (tooltip && nodeAnimationPromise) {
                    trackTooltipToNode(tooltip, nodeEl, codeElem, nodeAnimationPromise);
                }
                // Note: If node was already active (no animation), it's already at
                // its "raised" position, so initial positioning is correct
            }
        } else {
            // This is not a top node - remove all classes associated with styling top-level "active" node
            nodeEl.classList.remove('top', 'side-effect', 'has-value');
        }
    }

    // If no top node, remove any existing tooltip (should probably never happen)
    if(!topUUID) {
        removeCodeTooltip(codeElem);
    }

    // Wait for all animations to complete, then resolve with the result
    return Promise.all(animationPromises).then(() => stepResult);
}

/**
 * Format interpreter value for display in tooltip
 */
function formatInterpreterValue(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value, null, 2);
        } catch(e) {
            return value.toString();
        }
    }
    return String(value);
}

/**
 * Create a trace slider element for navigating through an execution trace
 * @param {Array} executionTrace - The execution trace from interpretCode
 * @param {Element} codeElem - The code element to animate
 * @returns {Element} The trace slider element
 */
// TODO: take in starting slider value and/or default to beginning? or is end good?
function createTraceSlider(executionTrace, codeElem) {
    // Create the slider container
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'trace-slider-container';

    sliderContainer.innerHTML = `
    <div class="trace-slider-controls">
        <button class="trace-slider-button trace-slider-prev" title="Previous step">◀</button>
        <div class="trace-slider-wrapper">
            <div class="trace-slider-notches"></div>
            <input type="range" class="trace-slider" step="1" min="0" max="${executionTrace.length - 1}" value="${executionTrace.length - 1}">
        </div>
        <button class="trace-slider-button trace-slider-next" title="Next step">▶</button>
        <button class="trace-slider-button trace-slider-play" title="Auto-play" data-playing="false">▶️</button>
    </div>
    `

    const notchesContainer =  sliderContainer.querySelector('.trace-slider-notches')
    for (let i = 0; i < executionTrace.length; i++) {
        const notch = document.createElement('div');
        notch.className = 'trace-slider-notch';
        notchesContainer.appendChild(notch);
    }

    // Extract references to specific parts of the slider structure (for use in logic below)
    const slider = sliderContainer.querySelector('.trace-slider');
    const prevButton = sliderContainer.querySelector('.trace-slider-prev');
    const nextButton = sliderContainer.querySelector('.trace-slider-next');
    const playButton = sliderContainer.querySelector('.trace-slider-play');

    // Function to update the trace slider display state (the slider itself, not the code visualization it controls)
    function updateSliderDisplay() {
        const currentStep = parseInt(slider.value);
        const totalSteps = executionTrace.length;

        // Update button states
        prevButton.disabled = currentStep === 0;
        nextButton.disabled = currentStep === totalSteps - 1;
    }

    // Function to jump to a specific step in the trace
    function jumpToStep(stepIndex, duration=300) {
        if (stepIndex < 0 || stepIndex >= executionTrace.length) return;

        slider.value = String(stepIndex);
        updateSliderDisplay();

        // Animate to this state
        return animateInterpreterState(executionTrace[stepIndex], codeElem, duration);
    }

    /**
     * Toggle automatic playback of the execution trace
     */
    async function togglePlayback() {
        const isPlaying = playButton.dataset.playing === 'true';

        if (isPlaying) {
            // Stop playback - just set the flag, the loop will notice and exit
            playButton.dataset.playing = 'false';
            // Note: UI update will happen in the finally block of the running loop
        } else {
            // Prevent multiple playback loops from running simultaneously
            if (sliderContainer.isPlaybackRunning) {
                return;
            }

            // Start playback
            playButton.dataset.playing = 'true';
            playButton.innerHTML = '⏸';
            playButton.title = 'Pause';
            sliderContainer.isPlaybackRunning = true;

            // If at end, restart from beginning
            if (parseInt(slider.value) >= executionTrace.length - 1) {
                //slider.value = '0';
                await jumpToStep(0, 500);
            }

            try {
                // Step forward, awaiting each animation before proceeding
                while (playButton.dataset.playing === 'true') {
                    const currentStep = parseInt(slider.value);
                    const nextStep = currentStep + 1;

                    if (nextStep < executionTrace.length) {
                        await jumpToStep(nextStep, 500);
                    } else {
                        // Reached end
                        break;
                    }
                }
            } catch (error) {
                console.error('Playback error:', error);
                // Could also show user-facing error notification here if desired
            } finally {
                // Always clean up, whether we:
                // - finished normally (reached end)
                // - were paused by user
                // - encountered an error
                playButton.dataset.playing = 'false';
                playButton.innerHTML = '▶️';
                playButton.title = 'Auto-play';
                sliderContainer.isPlaybackRunning = false;
            }
        }
    }

    // Event handlers
    // TODO: turn off playback on manual slider input? (slider click/forward/back click)
    slider.addEventListener('input', () => {
        jumpToStep(parseInt(slider.value));
    });

    prevButton.addEventListener('click', () => {
        jumpToStep(parseInt(slider.value) - 1);
    });

    nextButton.addEventListener('click', () => {
        jumpToStep(parseInt(slider.value) + 1);
    });

    playButton.addEventListener('click', () => {
        togglePlayback();
    });

    // Initialize display
    updateSliderDisplay();

    // Jump to last step to show final state
    jumpToStep(executionTrace.length - 1);

    // Store trace data and state on the container
    sliderContainer.executionTrace = executionTrace;
    sliderContainer.codeElem = codeElem;
    sliderContainer.jumpToStep = jumpToStep;
    sliderContainer.togglePlayback = togglePlayback;

    return sliderContainer;
}