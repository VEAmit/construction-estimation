namespace ConstructionEstimation.API.Middleware;

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class SkipLicenseValidationAttribute : Attribute
{
}
