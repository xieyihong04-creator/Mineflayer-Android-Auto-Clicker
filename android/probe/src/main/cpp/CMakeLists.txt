cmake_minimum_required(VERSION 3.22.1)
project(probe-libnode)

# libnode.so is extracted from the nodejs-mobile release by the fetchLibNode task.
# CMAKE_SOURCE_DIR is android/probe/src/main/cpp, so three levels up is :probe.
set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../build/libnode)

find_library(log-lib log)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
        IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE ${LIBNODE_DIR}/include/node)
target_link_libraries(native-lib libnode ${log-lib})
