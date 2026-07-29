using System.Security.Cryptography;
using System.Text;

namespace ConstructionEstimation.API.Services.Licensing;

public interface ILicenseMachineIdentifierProvider
{
    string GetIdentifier();
}

public sealed class LicenseMachineIdentifierProvider : ILicenseMachineIdentifierProvider
{
    public string GetIdentifier()
    {
        var source = string.Join(
            "|",
            Environment.MachineName,
            Environment.UserDomainName,
            System.Runtime.InteropServices.RuntimeInformation.OSArchitecture);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(source));
        return Convert.ToHexString(hash)[..32];
    }
}
