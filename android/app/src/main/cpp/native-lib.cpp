#include <jni.h>
#include <cstdlib>
#include <cstring>
#include "node.h"

// node::Start needs argc/argv in one contiguous block of memory, which is the
// whole reason this shim exists (nodejs-mobile exposes no Java API).
//
// Must stay in step with NodeService.kt: the symbol name is derived from the
// package, class and method. The probe has its own copy under dev.mcbot.probe
// on purpose - it is a separate APK that must not import product code.
extern "C" jint JNICALL
Java_dev_mcbot_console_NodeService_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments) {
    jsize argc = env->GetArrayLength(arguments);

    int bytes = 0;
    for (jsize i = 0; i < argc; i++) {
        jstring js = (jstring) env->GetObjectArrayElement(arguments, i);
        bytes += static_cast<int>(env->GetStringUTFLength(js)) + 1;
        env->DeleteLocalRef(js);
    }

    char *buffer = static_cast<char *>(calloc(static_cast<size_t>(bytes), sizeof(char)));
    char **argv = static_cast<char **>(calloc(static_cast<size_t>(argc), sizeof(char *)));
    char *cursor = buffer;

    for (jsize i = 0; i < argc; i++) {
        jstring js = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *arg = env->GetStringUTFChars(js, nullptr);
        size_t len = strlen(arg);
        memcpy(cursor, arg, len);
        cursor[len] = '\0';
        argv[i] = cursor;
        cursor += len + 1;
        env->ReleaseStringUTFChars(js, arg);
        env->DeleteLocalRef(js);
    }

    int result = node::Start(argc, argv);
    free(buffer);
    free(argv);
    return static_cast<jint>(result);
}
