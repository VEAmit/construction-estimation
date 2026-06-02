using ConstructionEstimation.Core.Entities;
using ConstructionEstimation.Core.Interfaces;
using ConstructionEstimation.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace ConstructionEstimation.Infrastructure.Repositories;

public class ProjectRepository : BaseRepository<Project>, IProjectRepository
{
    public ProjectRepository(AppDbContext context) : base(context) { }

    public async Task<IEnumerable<Project>> GetByUserIdAsync(int userId) =>
        await _dbSet
            .Include(p => p.Drawings)
            .Where(p => p.UserId == userId)
            .OrderByDescending(p => p.CreatedAt)
            .ToListAsync();

    public async Task<Project?> GetWithDrawingsAsync(int projectId) =>
        await _dbSet
            .Include(p => p.Drawings)
            .FirstOrDefaultAsync(p => p.Id == projectId);
}
