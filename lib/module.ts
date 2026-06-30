namespace Python {
    /** Parsed CPython runtime version. */
    export interface Version {
        major: number;
        minor: number;
        micro: number;
        /** PY_VERSION_HEX-style integer: major<<24 | minor<<16 | micro<<8 | ... */
        hex: number;
        /** Free-threaded (PEP 703, 3.13t+) build. */
        isFreeThreaded: boolean;
        /** Detected interpreter: "cpython", "pypy", "graalpy", "jython", or "unknown". */
        implementation: string;
        toString(): string;
    }

    /**
     * The lazily-resolved table of CPython C-API entry points, wrapped as Frida
     * NativeFunctions / data pointers. Built once on first access.
     *
     * NOTE: many "functions" in the C-API are macros and are NOT exported symbols
     * (Py_INCREF, Py_None, Py*_Check, PyRun_String...). We bind the real exported
     * equivalents instead — see exports.ts / the macro-vs-export table in PLAN.md.
     */
    export type Api = Record<string, any>;

    /** Module the runtime was resolved from (libpython / pythonXY.dll / main exe). */
    let _module: Module | null | undefined = undefined;
    let _api: Api | undefined = undefined;
    let _version: Version | undefined = undefined;

    /** Per-platform candidate name patterns for the CPython runtime image. */
    function candidatePatterns(): RegExp[] {
        switch (Process.platform) {
            case "windows":
                return [/^python3\d+t?\.dll$/i, /^python3\.dll$/i];
            case "darwin":
                return [/^Python$/, /^libpython3\.\d+t?\.dylib$/];
            default:
                return [/^libpython3\.\d+t?\.so(\.\d+(\.\d+)?)?$/];
        }
    }

    /**
     * Locate the live CPython runtime image. Resolves by *sentinel export*
     * (Py_GetVersion) rather than name alone, so shared-lib, framework AND
     * statically-linked/embedded interpreters are all supported.
     */
    function locate(): Module | null {
        // 1. Explicit user override.
        if ($config.moduleName !== undefined) {
            const m = Process.findModuleByName($config.moduleName);
            if (m !== null) return m;
        }

        const modules = Process.enumerateModules();

        // 2. Candidate-name match that also exports the sentinel.
        for (const re of candidatePatterns()) {
            for (const m of modules) {
                if (re.test(m.name) && m.findExportByName("Py_GetVersion") !== null) {
                    return m;
                }
            }
        }

        // 3. Any module that simply exports the sentinel (unusual names).
        for (const m of modules) {
            if (m.findExportByName("Py_GetVersion") !== null) return m;
        }

        // 4. Static / embedded / frozen host: the symbol lives in the main exe.
        const p = Module.findGlobalExportByName("Py_GetVersion");
        if (p !== null) return Process.findModuleByAddress(p);

        return null;
    }

    /** The resolved runtime module, or throws a clear error if none is found. */
    export function getModule(): Module {
        if (_module === undefined) _module = locate();
        if (_module === null) {
            throw new Error(
                "frida-python-bridge: could not locate a CPython runtime in this process " +
                    "(no module exports Py_GetVersion). If the interpreter is statically linked " +
                    "and stripped, set Python.$config.moduleName / Python.$config.exports."
            );
        }
        return _module;
    }

    /** Resolve a single symbol address using the layered strategy. */
    function resolveSymbol(name: string): NativePointer | null {
        const override = $config.exports[name];
        if (override !== undefined) {
            const h = override();
            if (h !== null && !h.isNull()) return h;
        }
        const m = getModule();
        return (
            m.findExportByName(name) ??
            m.findSymbolByName(name) ??
            Module.findGlobalExportByName(name)
        );
    }

    /** Build a NativeFunction over an export, or a Proxy that throws on first use. */
    function fn(name: string, retType: any, argTypes: any[]): any {
        const h = resolveSymbol(name);
        if (h === null || h.isNull()) {
            return new Proxy(function () {}, {
                apply() {
                    throw new Error(
                        `frida-python-bridge: couldn't resolve export '${name}' ` +
                            `(stripped / limited-ABI host? use Python.$config.exports['${name}'])`
                    );
                },
            });
        }
        return new NativeFunction(h, retType, argTypes, { exceptions: "propagate" });
    }

    /** Resolve a data symbol whose *address is itself* the object (e.g. _Py_NoneStruct). */
    function dataPtr(name: string): NativePointer {
        const h = resolveSymbol(name);
        return h ?? NULL;
    }

    /** Resolve a data symbol that holds a `PyObject *` slot (e.g. PyExc_RuntimeError). */
    function dataDeref(name: string): NativePointer {
        const h = resolveSymbol(name);
        return h !== null && !h.isNull() ? h.readPointer() : NULL;
    }

    /** Whether an export is present in this runtime. */
    export function hasExport(name: string): boolean {
        const h = resolveSymbol(name);
        return h !== null && !h.isNull();
    }

    /** Raw code address of an export (for CModule symbol maps); throws if unresolved. */
    export function symbolAddress(name: string): NativePointer {
        const h = resolveSymbol(name);
        if (h === null || h.isNull()) {
            throw new Error(`frida-python-bridge: couldn't resolve export '${name}'`);
        }
        return h;
    }

    function buildApi(): Api {
        const a: Api = {};

        // --- lifecycle / GIL / version -------------------------------------
        a.Py_IsInitialized = fn("Py_IsInitialized", "int", []);
        a.Py_IsFinalizing = hasExport("Py_IsFinalizing")
            ? fn("Py_IsFinalizing", "int", [])
            : () => 0;
        a.Py_GetVersion = fn("Py_GetVersion", "pointer", []);
        a.PyGILState_Ensure = fn("PyGILState_Ensure", "int", []);
        a.PyGILState_Release = fn("PyGILState_Release", "void", ["int"]);
        a.PyGILState_GetThisThreadState = fn("PyGILState_GetThisThreadState", "pointer", []);

        // --- code execution -------------------------------------------------
        // PyRun_String / Py_CompileString are macros; bind the *Flags symbols.
        if (hasExport("PyRun_StringFlags")) {
            a.PyRun_StringFlags = fn("PyRun_StringFlags", "pointer", [
                "pointer", "int", "pointer", "pointer", "pointer",
            ]);
        }
        if (hasExport("PyRun_SimpleStringFlags")) {
            a.PyRun_SimpleStringFlags = fn("PyRun_SimpleStringFlags", "int", ["pointer", "pointer"]);
        }
        a.Py_CompileStringExFlags = fn("Py_CompileStringExFlags", "pointer", [
            "pointer", "pointer", "int", "pointer", "int",
        ]);
        a.PyEval_EvalCode = fn("PyEval_EvalCode", "pointer", ["pointer", "pointer", "pointer"]);

        // --- import / namespaces -------------------------------------------
        a.PyImport_ImportModule = fn("PyImport_ImportModule", "pointer", ["pointer"]);
        a.PyImport_AddModule = fn("PyImport_AddModule", "pointer", ["pointer"]);
        a.PyModule_GetDict = fn("PyModule_GetDict", "pointer", ["pointer"]);
        a.PyEval_GetBuiltins = fn("PyEval_GetBuiltins", "pointer", []);

        // --- object protocol / introspection / call ------------------------
        a.PyObject_GetAttrString = fn("PyObject_GetAttrString", "pointer", ["pointer", "pointer"]);
        a.PyObject_SetAttrString = fn("PyObject_SetAttrString", "int", ["pointer", "pointer", "pointer"]);
        a.PyObject_HasAttrString = fn("PyObject_HasAttrString", "int", ["pointer", "pointer"]);
        a.PyObject_Call = fn("PyObject_Call", "pointer", ["pointer", "pointer", "pointer"]);
        a.PyObject_CallObject = fn("PyObject_CallObject", "pointer", ["pointer", "pointer"]);
        a.PyCallable_Check = fn("PyCallable_Check", "int", ["pointer"]);
        a.PyObject_Str = fn("PyObject_Str", "pointer", ["pointer"]);
        a.PyObject_Repr = fn("PyObject_Repr", "pointer", ["pointer"]);
        a.PyObject_Type = fn("PyObject_Type", "pointer", ["pointer"]);
        a.PyObject_Dir = fn("PyObject_Dir", "pointer", ["pointer"]);
        a.PyObject_IsInstance = fn("PyObject_IsInstance", "int", ["pointer", "pointer"]);
        a.PyObject_IsTrue = fn("PyObject_IsTrue", "int", ["pointer"]);
        a.PyObject_GetIter = fn("PyObject_GetIter", "pointer", ["pointer"]);
        a.PyIter_Next = fn("PyIter_Next", "pointer", ["pointer"]);
        a.PyObject_Length = fn("PyObject_Length", "ssize_t", ["pointer"]);
        a.PyObject_GetItem = fn("PyObject_GetItem", "pointer", ["pointer", "pointer"]);
        a.PyObject_SetItem = fn("PyObject_SetItem", "int", ["pointer", "pointer", "pointer"]);
        a.PyObject_RichCompareBool = fn("PyObject_RichCompareBool", "int", ["pointer", "pointer", "int"]);
        a.PyObject_Hash = fn("PyObject_Hash", "ssize_t", ["pointer"]);

        // --- conversions ----------------------------------------------------
        a.PyLong_FromLongLong = fn("PyLong_FromLongLong", "pointer", ["int64"]);
        a.PyLong_AsLongLong = fn("PyLong_AsLongLong", "int64", ["pointer"]);
        a.PyLong_AsLongLongAndOverflow = fn("PyLong_AsLongLongAndOverflow", "int64", ["pointer", "pointer"]);
        a.PyLong_FromString = fn("PyLong_FromString", "pointer", ["pointer", "pointer", "int"]);
        a.PyFloat_FromDouble = fn("PyFloat_FromDouble", "pointer", ["double"]);
        a.PyFloat_AsDouble = fn("PyFloat_AsDouble", "double", ["pointer"]);
        a.PyBool_FromLong = fn("PyBool_FromLong", "pointer", ["long"]);
        a.PyUnicode_FromString = fn("PyUnicode_FromString", "pointer", ["pointer"]);
        a.PyUnicode_FromStringAndSize = fn("PyUnicode_FromStringAndSize", "pointer", ["pointer", "ssize_t"]);
        if (hasExport("PyUnicode_AsUTF8AndSize")) {
            a.PyUnicode_AsUTF8AndSize = fn("PyUnicode_AsUTF8AndSize", "pointer", ["pointer", "pointer"]);
        }
        a.PyUnicode_AsUTF8String = fn("PyUnicode_AsUTF8String", "pointer", ["pointer"]);
        a.PyBytes_FromStringAndSize = fn("PyBytes_FromStringAndSize", "pointer", ["pointer", "ssize_t"]);
        a.PyBytes_AsStringAndSize = fn("PyBytes_AsStringAndSize", "int", ["pointer", "pointer", "pointer"]);

        // --- containers -----------------------------------------------------
        a.PyList_New = fn("PyList_New", "pointer", ["ssize_t"]);
        a.PyList_Append = fn("PyList_Append", "int", ["pointer", "pointer"]);
        a.PyList_GetItem = fn("PyList_GetItem", "pointer", ["pointer", "ssize_t"]);
        a.PyList_Size = fn("PyList_Size", "ssize_t", ["pointer"]);
        a.PyTuple_New = fn("PyTuple_New", "pointer", ["ssize_t"]);
        a.PyTuple_SetItem = fn("PyTuple_SetItem", "int", ["pointer", "ssize_t", "pointer"]);
        a.PyTuple_GetItem = fn("PyTuple_GetItem", "pointer", ["pointer", "ssize_t"]);
        a.PyTuple_Size = fn("PyTuple_Size", "ssize_t", ["pointer"]);
        a.PyDict_New = fn("PyDict_New", "pointer", []);
        a.PyDict_SetItem = fn("PyDict_SetItem", "int", ["pointer", "pointer", "pointer"]);
        a.PyDict_SetItemString = fn("PyDict_SetItemString", "int", ["pointer", "pointer", "pointer"]);
        a.PyDict_GetItemString = fn("PyDict_GetItemString", "pointer", ["pointer", "pointer"]);
        a.PyDict_Next = fn("PyDict_Next", "int", ["pointer", "pointer", "pointer", "pointer"]);

        // --- refcounting (FUNCTIONS, not the Py_INCREF/Py_DECREF macros) ----
        a.Py_IncRef = fn("Py_IncRef", "void", ["pointer"]);
        a.Py_DecRef = fn("Py_DecRef", "void", ["pointer"]);

        // --- errors ---------------------------------------------------------
        a.PyErr_Occurred = fn("PyErr_Occurred", "pointer", []);
        a.PyErr_Clear = fn("PyErr_Clear", "void", []);
        a.PyErr_Print = fn("PyErr_Print", "void", []);
        a.PyErr_SetString = fn("PyErr_SetString", "void", ["pointer", "pointer"]);
        a.PyErr_Fetch = fn("PyErr_Fetch", "void", ["pointer", "pointer", "pointer"]);
        a.PyErr_NormalizeException = fn("PyErr_NormalizeException", "void", ["pointer", "pointer", "pointer"]);
        a.PyErr_Restore = fn("PyErr_Restore", "void", ["pointer", "pointer", "pointer"]);
        if (hasExport("PyErr_GetRaisedException")) {
            a.PyErr_GetRaisedException = fn("PyErr_GetRaisedException", "pointer", []);
            a.PyErr_SetRaisedException = fn("PyErr_SetRaisedException", "void", ["pointer"]);
        }
        if (hasExport("PyErr_SetInterruptEx")) {
            a.PyErr_SetInterruptEx = fn("PyErr_SetInterruptEx", "int", ["int"]);
        }

        // --- hooking (PyCFunction trampoline) ------------------------------
        a.PyCFunction_NewEx = fn("PyCFunction_NewEx", "pointer", ["pointer", "pointer", "pointer"]);

        // --- singletons (data exports; address IS the object) --------------
        a.Py_None = dataPtr("_Py_NoneStruct");
        a.Py_True = dataPtr("_Py_TrueStruct");
        a.Py_False = dataPtr("_Py_FalseStruct");

        // --- type objects for checks (data exports; address IS the type) ---
        a.PyLong_Type = dataPtr("PyLong_Type");
        a.PyFloat_Type = dataPtr("PyFloat_Type");
        a.PyBool_Type = dataPtr("PyBool_Type");
        a.PyUnicode_Type = dataPtr("PyUnicode_Type");
        a.PyBytes_Type = dataPtr("PyBytes_Type");
        a.PyList_Type = dataPtr("PyList_Type");
        a.PyTuple_Type = dataPtr("PyTuple_Type");
        a.PyDict_Type = dataPtr("PyDict_Type");

        // --- exception types (data exports holding a PyObject* slot) -------
        a.PyExc_RuntimeError = dataDeref("PyExc_RuntimeError");

        // --- vectorcall fast paths (version-gated) -------------------------
        if (hasExport("PyObject_CallNoArgs")) a.PyObject_CallNoArgs = fn("PyObject_CallNoArgs", "pointer", ["pointer"]);
        if (hasExport("PyObject_CallOneArg")) a.PyObject_CallOneArg = fn("PyObject_CallOneArg", "pointer", ["pointer", "pointer"]);

        // --- buffer protocol (zero-copy bytes/bytearray/memoryview) --------
        a.PyObject_GetBuffer = fn("PyObject_GetBuffer", "int", ["pointer", "pointer", "int"]);
        a.PyBuffer_Release = fn("PyBuffer_Release", "void", ["pointer"]);

        // --- complex / slice / extra container types -----------------------
        a.PyComplex_RealAsDouble = fn("PyComplex_RealAsDouble", "double", ["pointer"]);
        a.PyComplex_ImagAsDouble = fn("PyComplex_ImagAsDouble", "double", ["pointer"]);
        a.PySlice_New = fn("PySlice_New", "pointer", ["pointer", "pointer", "pointer"]);
        a.PyComplex_Type = dataPtr("PyComplex_Type");
        a.PySet_Type = dataPtr("PySet_Type");
        a.PyFrozenSet_Type = dataPtr("PyFrozenSet_Type");
        a.PyByteArray_Type = dataPtr("PyByteArray_Type");

        // --- sys stdio (capture) -------------------------------------------
        a.PySys_GetObject = fn("PySys_GetObject", "pointer", ["pointer"]);
        a.PySys_SetObject = fn("PySys_SetObject", "int", ["pointer", "pointer"]);

        // --- thread/interpreter state --------------------------------------
        a.PyThreadState_Get = fn("PyThreadState_Get", "pointer", []);
        a.PyThreadState_Swap = fn("PyThreadState_Swap", "pointer", ["pointer"]);
        // Sub-interpreter targeting: create/dispose a thread state bound to a chosen interp.
        if (hasExport("PyThreadState_New")) a.PyThreadState_New = fn("PyThreadState_New", "pointer", ["pointer"]);
        if (hasExport("PyThreadState_Clear")) a.PyThreadState_Clear = fn("PyThreadState_Clear", "void", ["pointer"]);
        if (hasExport("PyThreadState_Delete")) a.PyThreadState_Delete = fn("PyThreadState_Delete", "void", ["pointer"]);
        if (hasExport("PyInterpreterState_ThreadHead")) a.PyInterpreterState_ThreadHead = fn("PyInterpreterState_ThreadHead", "pointer", ["pointer"]);
        if (hasExport("PyInterpreterState_Get")) a.PyInterpreterState_Get = fn("PyInterpreterState_Get", "pointer", []);
        if (hasExport("PyThreadState_GetInterpreter")) a.PyThreadState_GetInterpreter = fn("PyThreadState_GetInterpreter", "pointer", ["pointer"]);
        if (hasExport("PyInterpreterState_Head")) a.PyInterpreterState_Head = fn("PyInterpreterState_Head", "pointer", []);
        if (hasExport("PyInterpreterState_Next")) a.PyInterpreterState_Next = fn("PyInterpreterState_Next", "pointer", ["pointer"]);
        if (hasExport("PyInterpreterState_GetID")) a.PyInterpreterState_GetID = fn("PyInterpreterState_GetID", "int64", ["pointer"]);

        // --- frame introspection (3.9+ accessors) --------------------------
        a.PyEval_GetFrame = fn("PyEval_GetFrame", "pointer", []);
        if (hasExport("PyFrame_GetBack")) a.PyFrame_GetBack = fn("PyFrame_GetBack", "pointer", ["pointer"]);
        if (hasExport("PyFrame_GetCode")) a.PyFrame_GetCode = fn("PyFrame_GetCode", "pointer", ["pointer"]);
        a.PyFrame_GetLineNumber = fn("PyFrame_GetLineNumber", "int", ["pointer"]);

        // --- tracing / profiling -------------------------------------------
        a.PyEval_SetProfile = fn("PyEval_SetProfile", "void", ["pointer", "pointer"]);
        a.PyEval_SetTrace = fn("PyEval_SetTrace", "void", ["pointer", "pointer"]);

        // --- PEP 523 frame-eval hooking (internal API, 3.9+) ---------------
        if (hasExport("_PyInterpreterState_SetEvalFrameFunc"))
            a._PyInterpreterState_SetEvalFrameFunc = fn("_PyInterpreterState_SetEvalFrameFunc", "void", ["pointer", "pointer"]);
        if (hasExport("_PyEval_EvalFrameDefault"))
            a._PyEval_EvalFrameDefault = fn("_PyEval_EvalFrameDefault", "pointer", ["pointer", "pointer", "int"]);

        return a;
    }

    /** The resolved C-API table (built once). */
    export function getApi(): Api {
        if (_api === undefined) _api = buildApi();
        return _api;
    }

    function parseVersion(): Version {
        const api = getApi();
        const verStr = (api.Py_GetVersion() as NativePointer).readCString() ?? "0.0.0";
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(verStr);
        const major = m ? parseInt(m[1], 10) : 0;
        const minor = m ? parseInt(m[2], 10) : 0;
        const micro = m ? parseInt(m[3], 10) : 0;
        const isFreeThreaded = /free-threading build/.test(verStr);
        const implementation = /PyPy/i.test(verStr)
            ? "pypy"
            : /GraalVM|GraalPy/i.test(verStr)
              ? "graalpy"
              : /Jython/i.test(verStr)
                ? "jython"
                : major >= 3
                  ? "cpython"
                  : "unknown";
        return {
            major,
            minor,
            micro,
            hex: (major << 24) | (minor << 16) | (micro << 8),
            isFreeThreaded,
            implementation,
            toString() {
                return `${major}.${minor}.${micro}${isFreeThreaded ? "t" : ""}`;
            },
        };
    }

    /** The detected CPython version (parsed from Py_GetVersion). */
    export function getVersion(): Version {
        if (_version === undefined) _version = parseVersion();
        return _version;
    }

    /**
     * Verify the located runtime is CPython (PyPy/Jython/GraalPy expose a different /
     * incompatible object model). Throws otherwise. Safe to call repeatedly.
     */
    export function assertCPython(): void {
        const v = getVersion();
        if (v.implementation !== "cpython") {
            throw new Error(
                `frida-python-bridge: ${v.implementation} is not supported (CPython only)`
            );
        }
        if (getModule().findExportByName("_Py_NoneStruct") === null && !hasExport("_Py_NoneStruct")) {
            throw new Error("frida-python-bridge: located runtime is not CPython (no _Py_NoneStruct)");
        }
    }

    let _warmed = false;

    /**
     * Pre-create this thread's PyThreadState once, mitigating the cpython#96071
     * first-`PyGILState_Ensure` deadlock on a fresh Frida thread (3.11+ w/ tracemalloc).
     */
    export function warmUp(): void {
        if (_warmed) return;
        _warmed = true;
        const api = getApi();
        if ((api.Py_IsInitialized() as number) === 0) return;
        const st = api.PyGILState_Ensure() as number;
        api.PyGILState_Release(st);
    }
}
