Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\abhij\Ghost"
sh.Run """C:\Users\abhij\Ghost\node_modules\electron\dist\electron.exe"" ""C:\Users\abhij\Ghost""", 0, False
