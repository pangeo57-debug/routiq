from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

def create_data_model():
    data = {}
    # Διάρκεια μαθήματος: Depot(0), S001(60), S002(45), S003(90), S004(60)
    data['service_time'] = [0, 60, 45, 90, 60] 
    
    # Χρονικά παράθυρα (σε λεπτά από την έναρξη της ημέρας)
    data['time_windows'] = [
        (0, 1440),  # Καθηγητής (Όλη μέρα)
        (300, 780), # Student S001 (10:00 - 13:00)
        (420, 720), # Student S002 (12:00 - 17:00)
        (540, 840), # Student S003 (14:00 - 19:00)
        (360, 780)  # Student S004 (11:00 - 13:00)
    ]
    
    # Χρόνοι οδήγησης μεταξύ των σημείων
    data['distance_matrix'] = [
        [0, 18, 22, 34, 45],
        [18, 0, 17, 32, 50],
        [22, 17, 0, 39, 56],
        [34, 32, 39, 0, 24],
        [45, 50, 56, 24, 0]
    ]
    data['depot'] = 0
    return data

def print_solution(manager, routing, solution):
    """Τυπώνει τη λύση στην κοσόλα με κατανοητό τρόπο."""
    print(f'Συνολικός Χρόνος Διαδρομής (Objective): {solution.ObjectiveValue()} λεπτά\n')
    index = routing.Start(0)
    plan_output = 'Πλάνο Δρομολογίου Καθηγητή:\n'
    time_dimension = routing.GetDimensionOrDie('Time')
    
    while not routing.IsEnd(index):
        node = manager.IndexToNode(index)
        time_var = time_dimension.CumulVar(index)
        # Μετατροπή των λεπτών σε ώρες:λεπτά για να διαβάζεται εύκολα
        min_time = solution.Min(time_var)
        max_time = solution.Max(time_var)
        
        if node == 0:
            plan_output += f'🏠 Σημείο Εκκίνησης (Σπίτι) -> Ώρα Αναχώρησης: [{min_time//60:02d}:{min_time%60:02d}]\n'
        else:
            plan_output += f'📖 Μαθητής S00{node} -> Άφιξη μεταξύ: [{min_time//60:02d}:{min_time%60:02d}] και [{max_time//60:02d}:{max_time%60:02d}]\n'
        
        index = solution.Value(routing.NextVar(index))

    time_var = time_dimension.CumulVar(index)
    min_time = solution.Min(time_var)
    plan_output += f'🏠 Επιστροφή στο Σπίτι -> Ώρα Άφιξης: [{min_time//60:02d}:{min_time%60:02d}]\n'
    print(plan_output)

def main():
    data = create_data_model()
    manager = pywrapcp.RoutingIndexManager(len(data['distance_matrix']), 1, data['depot'])
    routing = pywrapcp.RoutingModel(manager)

    def time_callback(from_index, to_index):
        """Επιστρέφει: Χρόνο Οδήγησης + Χρόνο Διδασκαλίας του τρέχοντος μαθητή"""
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        # 👑 ΔΙΟΡΘΩΣΗ 1: Οδήγηση + Διάρκεια Μαθήματος
        return data['distance_matrix'][from_node][to_node] + data['service_time'][from_node]

    transit_callback_index = routing.RegisterTransitCallback(time_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    # Προσθήκη Διάστασης Χρόνου
    time = 'Time'
    routing.AddDimension(
        transit_callback_index,
        1440, # 👑 ΔΙΟΡΘΩΣΗ 2: Μεγάλο Slack (επιτρέπει στον καθηγητή να περιμένει αν φτάσει νωρίτερα)
        1440, # Μέγιστος χρόνος ημέρας
        True, # 👑 ΔΙΟΡΘΩΣΗ 3: Ξεκινάμε το μέτρημα από το 0 (00:00 το βράδυ)
        time)
    
    time_dimension = routing.GetDimensionOrDie(time)
    
    # Εφαρμογή των Time Windows
    for location_idx, time_window in enumerate(data['time_windows']):
        if location_idx != data['depot']:
            index = manager.NodeToIndex(location_idx)
            time_dimension.CumulVar(index).SetRange(time_window[0], time_window[1])

    # Παράμετροι Αναζήτησης
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC)

    solution = routing.SolveWithParameters(search_parameters)

    if solution:
        print_solution(manager, routing, solution)
    else:
        print('Δεν βρέθηκε εφικτή λύση με αυτούς τους περιορισμούς!')

if __name__ == '__main__':
    main()
