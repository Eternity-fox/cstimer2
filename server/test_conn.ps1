try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("202.182.125.24", 19766)
    Write-Host "TCP Connected: $($tcp.Connected)"
    $stream = $tcp.GetStream()
    Start-Sleep -Milliseconds 1500
    Write-Host "Still connected after 1.5s? $($tcp.Connected)"
    $b = $stream.ReadByte()
    Write-Host "ReadByte returned: $b"
    $tcp.Close()
} catch {
    Write-Host "Error: $_"
}
