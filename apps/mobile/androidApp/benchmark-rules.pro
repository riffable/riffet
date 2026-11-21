# The benchmark build keeps R8's shrinking but neither its renaming nor its optimisation (which
# merges and inlines classes into one another), so simpleperf and Perfetto show the real call
# stack. ART still compiles the code ahead of time, as for a release install.
-dontobfuscate
-dontoptimize
