using System.Text.Json.Serialization;

namespace ConstructionEstimation.Core.Common;

public class ApiResponse<T>
{
    public bool Success { get; set; }
    public string Message { get; set; } = string.Empty;
    public T? Data { get; set; }
    public List<string> Errors { get; set; } = new();
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Code { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool RequiresLogout { get; set; }

    public static ApiResponse<T> Ok(T data, string message = "Success") =>
        new() { Success = true, Message = message, Data = data };

    public static ApiResponse<T> Fail(string error) =>
        new() { Success = false, Message = error, Errors = new List<string> { error } };

    public static ApiResponse<T> Fail(string error, string code, bool requiresLogout = false) =>
        new()
        {
            Success = false,
            Message = error,
            Errors = new List<string> { error },
            Code = code,
            RequiresLogout = requiresLogout
        };

    public static ApiResponse<T> Fail(List<string> errors) =>
        new() { Success = false, Message = "Validation failed", Errors = errors };
}
