# A window the live check owns outright.
#
# Spec §69 and Phase 7 §10: live runs act on something the test created, never on
# a real application and never near real user data. Windows 11 Notepad is
# single-instance and tabbed, so "launch a Notepad and close it afterwards"
# actually means "add a tab to whatever the user already had open, then kill the
# whole application" — which is exactly the rule it looks like it is obeying.
#
# So the fixture is built here instead. Windows Forms controls carry real UI
# Automation providers, which makes this a fair target for a tree walk: a button,
# a writable edit, a toggle, static text, a named group and a radio button, each
# with a name the check can assert on.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
# ASCII only, deliberately. Windows PowerShell 5.1 reads a .ps1 with no BOM as
# ANSI, so a UTF-8 em-dash here arrives as "a???" and the check's exact-title
# match silently never fires - it just reports that the window never opened.
$form.Text = 'SAMIX live check - safe to close'
$form.Width = 460
$form.Height = 320
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$send = New-Object System.Windows.Forms.Button
$send.Text = 'Send'; $send.Left = 24; $send.Top = 24; $send.Width = 90

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'; $cancel.Left = 130; $cancel.Top = 24; $cancel.Width = 90

$message = New-Object System.Windows.Forms.TextBox
$message.Text = 'hello'; $message.Left = 24; $message.Top = 70; $message.Width = 260
$message.AccessibleName = 'Message'

$remember = New-Object System.Windows.Forms.CheckBox
$remember.Text = 'Remember me'; $remember.Left = 24; $remember.Top = 110; $remember.Width = 160

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Status: ready'; $status.Left = 24; $status.Top = 150; $status.Width = 260

$options = New-Object System.Windows.Forms.GroupBox
$options.Text = 'Options'; $options.Left = 24; $options.Top = 180
$options.Width = 260; $options.Height = 60
$plain = New-Object System.Windows.Forms.RadioButton
$plain.Text = 'Plain text'; $plain.Left = 12; $plain.Top = 22; $plain.Width = 110
$options.Controls.Add($plain)

$form.Controls.AddRange(@($send, $cancel, $message, $remember, $status, $options))
[System.Windows.Forms.Application]::Run($form)
