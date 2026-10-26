import sys, os, pydoc, io, contextlib
out = sys.argv[1]
os.chdir(out)
skip = {'antigravity','this','idlelib','turtledemo','tkinter','turtle','test','lib2to3','pydoc_data','ensurepip','venv','msilib','winreg','winsound','msvcrt','nt','_winapi','readline','curses','dbm','zipapp','sre_compile','sre_constants','sre_parse','distutils','__phello__','__hello__','xxlimited','xxlimited_35','symtable','pdb','profile','cProfile','trace','tabnanny','webbrowser','smtpd','asyncore','asynchat','imp'}
names = sorted(n for n in sys.stdlib_module_names if not n.startswith('_') and n not in skip)
done = 0
for n in names:
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            pydoc.writedoc(n)
        done += 1
    except BaseException as e:
        pass
print('modules', len(names), 'written', done)
