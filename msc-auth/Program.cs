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

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

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

    internal static IAccount? SelectAccount(
        IReadOnlyList<IAccount> accounts, string? accountId, string? upn, string tenant)
    {
        var selector = accountId ?? upn;
        IAccount? selected = null;
        foreach (var candidate in accounts)
        {
            var matches = selector is null
                ? string.Equals(candidate.HomeAccountId.TenantId, tenant, StringComparison.OrdinalIgnoreCase)
                : string.Equals(candidate.Username, selector, StringComparison.OrdinalIgnoreCase)
                    || (accountId is not null && string.Equals(
                        candidate.HomeAccountId.Identifier, selector, StringComparison.OrdinalIgnoreCase));
            if (!matches)
            {
                continue;
            }
            if (selected is not null)
            {
                return null;
            }
            selected = candidate;
        }

        return selected ?? (selector is null && accounts.Count == 1 ? accounts[0] : null);
    }

    private static async Task<int> Main(string[] args)
    {
        var interactive = HasFlag(args, "--interactive");
        var verbose = HasFlag(args, "--verbose");
        var listAccounts = HasFlag(args, "--accounts");
        var tenant = GetArgument(args, "--tenant") ?? DefaultTenantId;
        var upn = GetArgument(args, "--upn");
        var accountId = GetArgument(args, "--account");

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
                    if ((verbose || level != LogLevel.Always)
                        && level <= (verbose ? LogLevel.Info : LogLevel.Warning))
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
            if (verbose)
            {
                Console.Error.WriteLine($"[msc-auth] broker accounts: {accounts.Count}");
                foreach (var candidate in accounts)
                {
                    Console.Error.WriteLine(
                        $"[msc-auth] {candidate.Username}  home={candidate.HomeAccountId.Identifier}  env={candidate.Environment}");
                }
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
                Console.WriteLine($"{candidate.Username}\t{candidate.HomeAccountId.Identifier}\t{candidate.Environment}");
            }

            return 0;
        }

        account = SelectAccount(accounts, accountId, upn, tenant);
        if (account is null && !interactive)
        {
            var selector = accountId ?? upn;
            Console.Error.WriteLine(selector is null
                ? "[msc-auth] no unique broker account selected; use --accounts, then --account <home id or email>, or --interactive"
                : $"[msc-auth] no unique account matched {selector}; use --accounts and select the home account id, or --interactive to sign in");
            return 2;
        }

        if (verbose)
        {
            Console.Error.WriteLine($"[msc-auth] selected: {account?.Username ?? "(none)"}  authority={tenant}");
        }

        AuthenticationResult result;
        try
        {
            // `--interactive` wins over silent acquisition: its purpose is to repair a
            // broker session that silent acquisition can no longer satisfy.
            if (interactive)
            {
                var parentWindow = GetConsoleWindow();
                if (parentWindow == IntPtr.Zero)
                {
                    parentWindow = GetForegroundWindow();
                }
                var builder = app
                    .AcquireTokenInteractive(new[] { ResourceScope })
                    .WithParentActivityOrWindow(parentWindow)
                    .WithUseEmbeddedWebView(false)
                    .WithPrompt(Prompt.SelectAccount);
                if (account is not null)
                {
                    builder = builder.WithAccount(account);
                }
                else if (upn is not null || accountId?.Contains('@') == true)
                {
                    builder = builder.WithLoginHint(upn ?? accountId);
                }

                result = await builder.ExecuteAsync();
            }
            else
            {
                result = await app
                    .AcquireTokenSilent(new[] { ResourceScope }, account!)
                    .ExecuteAsync();
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
            result.Account.HomeAccountId.Identifier,
            result.Account.Environment,
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
    [property: JsonPropertyName("home_account_id")] string HomeAccountId,
    [property: JsonPropertyName("environment")] string Environment,
    [property: JsonPropertyName("scopes")] string[] Scopes);

[JsonSerializable(typeof(TokenPayload))]
internal sealed partial class TokenJson : JsonSerializerContext;
