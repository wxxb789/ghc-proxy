using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Identity.Client;
using Microsoft.Identity.Client.Broker;

namespace MscAuth;

/// <summary>
/// Minimal Windows token broker client for the Microsoft 365 Copilot LLM gateway.
/// Parameters recovered from the app's own WAM request record:
///   client_id 0ec893e0-5785-4de6-99da-4ed124e5296c ("Microsoft 365 Copilot")
///   scope     api://42c8f7bd-c7a8-4ba9-bc1c-91edfb716247/.default offline_access openid profile
///   authority login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47
/// The token goes to stdout as one JSON object; diagnostics go to stderr.
/// </summary>
internal static class Program
{
    private const string ClientId = "0ec893e0-5785-4de6-99da-4ed124e5296c";
    private const string DefaultTenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    private const string ResourceScope = "api://42c8f7bd-c7a8-4ba9-bc1c-91edfb716247/.default";
    private const string DefaultUpn = "lhan@microsoft.com";

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    private static string? GetArgument(string[] args, string name)
    {
        for (var index = 0; index < args.Length - 1; index++)
        {
            if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[index + 1];
            }
        }

        return null;
    }

    private static bool HasFlag(string[] args, string name) =>
        args.Contains(name, StringComparer.OrdinalIgnoreCase);

    private static async Task<int> Main(string[] args)
    {
        var interactive = HasFlag(args, "--interactive");
        var verbose = HasFlag(args, "--verbose");
        var listAccounts = HasFlag(args, "--accounts");
        var tenant = GetArgument(args, "--tenant") ?? DefaultTenantId;
        var upn = GetArgument(args, "--upn");

        var app = PublicClientApplicationBuilder
            .Create(ClientId)
            .WithAuthority(AzureCloudInstance.AzurePublic, tenant)
            .WithRedirectUri($"ms-appx-web://Microsoft.AAD.BrokerPlugin/{ClientId}")
            .WithBroker(new BrokerOptions(BrokerOptions.OperatingSystems.Windows)
            {
                Title = "msc-auth",
                ListOperatingSystemAccounts = true,
            })
            .WithLogging(
                (level, message, _) =>
                {
                    if (level <= (verbose ? LogLevel.Info : LogLevel.Warning))
                    {
                        Console.Error.WriteLine($"[msal:{level}] {message}");
                    }
                },
                verbose ? LogLevel.Info : LogLevel.Warning,
                enablePiiLogging: false)
            .Build();

        IAccount? account = null;
        List<IAccount> accounts;
        try
        {
            accounts = (await app.GetAccountsAsync()).ToList();
            Console.Error.WriteLine($"[msc-auth] broker accounts: {accounts.Count}");
            foreach (var candidate in accounts)
            {
                Console.Error.WriteLine(
                    $"[msc-auth] {candidate.Username}  home={candidate.HomeAccountId}  env={candidate.Environment}");
            }
        }
        catch (MsalException error)
        {
            Console.Error.WriteLine($"[msc-auth] GetAccountsAsync failed: {error.ErrorCode}: {error.Message}");
            return 3;
        }

        if (listAccounts)
        {
            foreach (var candidate in accounts)
            {
                Console.WriteLine($"{candidate.Username}\t{candidate.HomeAccountId}\t{candidate.Environment}");
            }

            return 0;
        }

        var target = upn ?? DefaultUpn;
        account = accounts.FirstOrDefault(
                candidate => candidate.Username.Equals(target, StringComparison.OrdinalIgnoreCase))
            ?? accounts.FirstOrDefault(
                candidate => candidate.Username.Contains(target, StringComparison.OrdinalIgnoreCase));

        if (account is null && upn is null)
        {
            var preferred = GetArgument(args, "--prefer") ?? "microsoft.com";
            account = accounts.FirstOrDefault(
                candidate => candidate.Username.Contains(preferred, StringComparison.OrdinalIgnoreCase));
        }

        if (account is null && accounts.Count == 1)
        {
            account = accounts[0];
        }

        if (account is null && accounts.Count > 1)
        {
            Console.Error.WriteLine("[msc-auth] no account matched; use --accounts to list and --upn to pick");
        }

        Console.Error.WriteLine($"[msc-auth] selected: {account?.Username ?? "(none)"}  authority={tenant}");

        AuthenticationResult result;
        try
        {
            if (account is not null)
            {
                result = await app
                    .AcquireTokenSilent(new[] { ResourceScope }, account)
                    .ExecuteAsync();
            }
            else if (interactive)
            {
                result = await app
                    .AcquireTokenInteractive(new[] { ResourceScope })
                    .WithParentActivityOrWindow(GetConsoleWindow())
                    .WithUseEmbeddedWebView(false)
                    .ExecuteAsync();
            }
            else
            {
                Console.Error.WriteLine("[msc-auth] no account selected; use --accounts to list, --upn to pick, or --interactive");
                return 2;
            }
        }
        catch (MsalUiRequiredException error)
        {
            Console.Error.WriteLine($"[msc-auth] silent failed, interaction required: {error.ErrorCode}");
            return 2;
        }
        catch (MsalException error)
        {
            Console.Error.WriteLine($"[msc-auth] {error.ErrorCode}: {error.Message}");
            return 3;
        }

        var payload = new TokenPayload(
            result.AccessToken,
            result.ExpiresOn.ToUniversalTime().ToString("o"),
            result.TenantId,
            result.Account.Username,
            result.Scopes.ToArray());

        Console.WriteLine(JsonSerializer.Serialize(payload, TokenJson.Default.TokenPayload));
        return 0;
    }
}

internal sealed record TokenPayload(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("expires_on")] string ExpiresOn,
    [property: JsonPropertyName("tenant")] string Tenant,
    [property: JsonPropertyName("username")] string Username,
    [property: JsonPropertyName("scopes")] string[] Scopes);

[JsonSerializable(typeof(TokenPayload))]
internal sealed partial class TokenJson : JsonSerializerContext;
