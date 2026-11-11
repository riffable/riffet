# R8 rules for the release build. Libraries that ship consumer rules (coroutines, OkHttp, Coil,
# CameraX, Compose) are covered by those; what follows is what this app relies on beyond them.

# kotlinx.serialization: every DTO in riffet.contracts / riffet.shared is decoded through the
# plugin-generated serializers, which are looked up through the companion when the type is not
# known statically (generic and polymorphic paths).
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod
-dontnote kotlinx.serialization.**
-keepclassmembers @kotlinx.serialization.Serializable class riffet.** {
    *** Companion;
    *** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class riffet.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class riffet.**$$serializer { *; }
-keepclassmembers class riffet.**$Companion {
    kotlinx.serialization.KSerializer serializer(...);
}

# Ktor: `HttpClient { }` finds its engine (OkHttp) through ServiceLoader, and Ktor's atomics update
# volatile fields by name.
-keep class * implements io.ktor.client.HttpClientEngineContainer
-keep class io.ktor.client.engine.okhttp.** { *; }
-keepclassmembers class io.ktor.** {
    volatile <fields>;
}
-dontwarn io.ktor.**
-dontwarn org.slf4j.**
-dontwarn java.lang.management.**
